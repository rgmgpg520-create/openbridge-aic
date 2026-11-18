import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.environ.get("OPENBRIDGE_MODEL_DIR", os.path.join(ROOT, "..", "qwen", "Qwen", "Qwen3-VL-2B-Instruct"))
HOST = os.environ.get("MODEL_HOST", "127.0.0.1")
PORT = int(os.environ.get("MODEL_PORT", "8080"))

if not os.path.isdir(MODEL_DIR):
    raise SystemExit(f"Model directory does not exist: {MODEL_DIR}")


def ensure_port_available(host, port):
    """Refuse to start when another service already holds the port.

    Loading the weights costs several GB of VRAM. If a second instance starts
    and only finds out about the conflict when it binds (after loading), it
    silently consumes GPU memory and makes the *first* instance fail every
    request with CUDA out of memory. Check the port before touching the GPU.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Deliberately no SO_REUSEADDR: on Windows that flag would let the probe
        # bind a port another process is already listening on.
        probe.bind((host, port))
    except OSError as exc:
        raise SystemExit(
            f"Port {host}:{port} is already in use ({exc}).\n"
            "Another OpenBridge model service is probably running. "
            "Stop it before starting a new one, otherwise both instances share "
            "the GPU and every request fails with CUDA out of memory."
        )
    finally:
        probe.close()


ensure_port_available(HOST, PORT)

processor = AutoProcessor.from_pretrained(MODEL_DIR, local_files_only=True)
model = Qwen3VLForConditionalGeneration.from_pretrained(
    MODEL_DIR,
    torch_dtype="auto",
    device_map="auto",
    local_files_only=True,
)
model.eval()

# One GPU, one generation at a time: the web server and the benchmark script can
# call this service concurrently, and interleaved forwards would corrupt timing
# and can exhaust VRAM.
GENERATE_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # The caller gave up (e.g. the Node service aborts after its timeout)
            # while we were still generating. Dropping the response is expected
            # and must not spam the console or stop the service.
            pass

    def do_GET(self):
        if self.path == "/v1/models":
            self.send_json(200, {"data": [{"id": "Qwen3-VL-2B-Instruct"}]})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": "not found"})
            return
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            messages = request.get("messages", [])
            prompt = "\n".join(f"{item.get('role', 'user')}: {item.get('content', '')}" for item in messages)
            inputs = processor.apply_chat_template(
                [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
                tokenize=True,
                add_generation_prompt=True,
                return_dict=True,
                return_tensors="pt",
            ).to(model.device)
            answer = None
            with GENERATE_LOCK, torch.inference_mode():
                try:
                    output = model.generate(
                        **inputs,
                        max_new_tokens=min(int(request.get("max_tokens", 280)), 512),
                        do_sample=False,
                        # Greedy decoding on a 2B model tends to repeat whole sentences
                        # in long structured answers; a mild penalty keeps the format
                        # while removing verbatim loops.
                        repetition_penalty=float(os.environ.get("OPENBRIDGE_REPETITION_PENALTY", "1.12")),
                        # A rotating citation-marker loop (e.g. [E1][E2][E3]...) is not
                        # a single repeated token, so repetition_penalty misses it. Ban
                        # repeated 6-grams to deterministically stop such token loops;
                        # set OPENBRIDGE_NO_REPEAT_NGRAM=0 to disable.
                        no_repeat_ngram_size=int(os.environ.get("OPENBRIDGE_NO_REPEAT_NGRAM", "6")),
                    )
                    generated = output[0][inputs.input_ids.shape[-1]:]
                    answer = processor.decode(generated, skip_special_tokens=True).strip()
                finally:
                    # Free the per-request KV cache / activations. On an 8GB laptop
                    # GPU the CUDA caching allocator otherwise keeps the fragmented
                    # peak after a long LICENSE prompt, and the next long request
                    # fails with an out-of-memory 500.
                    try:
                        del output
                    except NameError:
                        pass
                    torch.cuda.empty_cache()
            self.send_json(200, {"choices": [{"message": {"role": "assistant", "content": answer}}]})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})

    def log_message(self, fmt, *args):
        print(fmt % args)


def warmup():
    """Pay the cold-start cost before the first real request.

    Loading weights is not enough: the first forward pass still allocates CUDA
    workspaces and compiles kernels. On a 3k character evidence prompt that
    first call can exceed the caller's timeout, so the client gives up and the
    service later writes into a closed socket. Doing a tiny generation here
    moves that cost into startup.
    """
    started = time.time()
    try:
        inputs = processor.apply_chat_template(
            [{"role": "user", "content": [{"type": "text", "text": "warmup"}]}],
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(model.device)
        with GENERATE_LOCK, torch.inference_mode():
            model.generate(**inputs, max_new_tokens=4, do_sample=False)
        print(f"Warmup finished in {time.time() - started:.1f}s", flush=True)
    except Exception as exc:  # warmup must never prevent the service from starting
        print(f"Warmup skipped: {exc}", flush=True)


print(f"Loading {MODEL_DIR}", flush=True)
warmup()
print(f"OpenBridge Qwen service at http://{HOST}:{PORT}", flush=True)
ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

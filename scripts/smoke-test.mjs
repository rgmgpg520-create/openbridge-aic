import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const base = process.env.OPENBRIDGE_URL || 'http://127.0.0.1:4173';
const defaultProject = JSON.parse(await fs.readFile(new URL('../data/sample-project.json', import.meta.url), 'utf8'));

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload };
}

const { response: defaultResponse, payload: defaultAnswer } = await post('/api/ask', {
  question: 'Requests 的 get 方法在哪里实现？',
  project: defaultProject
});
assert.equal(defaultResponse.status, 200);
assert.ok(defaultAnswer.sources.some((source) => source.id === 'api-code'));
assert.ok(defaultAnswer.sources.every((source) => source.source.includes('611c6162')));

const importedProject = structuredClone(defaultProject);
importedProject.project.name = 'DemoLib';
importedProject.project.displayName = 'Demo Library';
importedProject.project.url = 'https://example.org/demo';
importedProject.project.snapshotCommit = 'demo-1';
importedProject.documents = [{
  id: 'demo-guide',
  type: 'README',
  title: 'Demo Library Installation Guide',
  source: 'https://example.org/demo/install',
  evidencePath: '../../Windows/win.ini',
  content: 'Install Demo Library with pip install demolib. Python 3.11 is supported.',
  tags: ['install', 'pip', 'python']
}];
importedProject.resources = [];
importedProject.testCases = [{
  id: 'D01',
  query: 'How do I install Demo Library?',
  mustCite: 'demo-guide',
  expectedKeywords: ['pip install', 'Python 3.11']
}];

const { response: importedResponse, payload: importedAnswer } = await post('/api/ask', {
  question: 'How do I install Demo Library?',
  project: importedProject
});
assert.equal(importedResponse.status, 200);
assert.ok(importedAnswer.answer.includes('Demo Library'));
assert.equal(importedAnswer.sources[0].id, 'demo-guide');
assert.equal(importedAnswer.sources[0].localPath, null);

const { response: validationResponse, payload: validation } = await post('/api/validate', { project: importedProject });
assert.equal(validationResponse.status, 200);
assert.equal(validation.total, 1);
assert.equal(validation.citationRecall, 100);

const { response: invalidResponse } = await post('/api/ask', { question: '', project: importedProject });
assert.equal(invalidResponse.status, 400);

console.log('Smoke tests passed: default project, imported project, project tests, path isolation, invalid input.');

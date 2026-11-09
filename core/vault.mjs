import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inspectMarkdown } from './annotations.mjs';
import { validateModel, buildIndex } from './engine.js';

async function collectMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

export async function loadVault(root) {
  const modelPath = path.join(root, 'ontology', 'ontology.json');
  let modelText;
  try {
    modelText = await readFile(modelPath, 'utf8');
  } catch (err) {
    throw new Error(`模型文件缺失: ${modelPath} (${err.message})`);
  }

  let model;
  try {
    model = JSON.parse(modelText);
  } catch (err) {
    throw new Error(`模型文件 JSON 无效: ${modelPath} (${err.message})`);
  }

  try {
    validateModel(model);
  } catch (err) {
    throw new Error(`模型定义校验失败: ${modelPath} (${err.message})`);
  }

  const allFiles = [];
  for (const folder of model.folders) {
    const folderFiles = await collectMarkdownFiles(path.join(root, folder));
    allFiles.push(...folderFiles);
  }

  const notes = [], annotations = [], documentIssues = [];

  for (const filePath of allFiles) {
    const relPath = path.relative(root, filePath).split(path.sep).join('/');
    const text = await readFile(filePath, 'utf8');
    const parsed = inspectMarkdown(text, relPath);
    annotations.push(...parsed.annotations); documentIssues.push(...parsed.issues);
    if (parsed.frontmatter !== null) notes.push({ path: relPath, frontmatter: parsed.frontmatter, body: parsed.body });
  }

  const index = buildIndex(notes, model);
  index.issues.push(...documentIssues);
  index.annotations = annotations;

  return { model, index, notes };
}

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
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

  const notes = [];
  const yamlIssues = [];

  for (const filePath of allFiles) {
    const relPath = path.relative(root, filePath).split(path.sep).join('/');
    const text = await readFile(filePath, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) continue;

    let fm;
    try {
      fm = YAML.parse(match[1]);
    } catch (err) {
      yamlIssues.push({ path: relPath, message: `YAML 解析失败: ${err.message}` });
      continue;
    }

    notes.push({ path: relPath, frontmatter: fm, body: match[2] });
  }

  const index = buildIndex(notes, model);
  index.issues.push(...yamlIssues);

  return { model, index, notes };
}

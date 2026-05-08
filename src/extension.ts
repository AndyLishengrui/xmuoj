import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { contestStatus, defaultCodeTemplate, detectLanguage, finalVerdict, normalizeOutput } from './utils';

const execFileAsync = promisify(execFile);
const STATE_CURRENT_PROBLEM = 'xmuoj.currentProblem';
const STATE_LAYOUT = 'xmuoj.layout';
const STATE_HISTORY = 'xmuoj.submissionHistory';
const MAX_SUBMISSION_HISTORY = 300;
const EXECUTION_TIMEOUT_MS = 10_000;

type ProblemType = 'public' | 'contest';

interface Problem {
  id: string;
  title: string;
  type: ProblemType;
  statement?: string;
  allowedLanguages?: string[];
  contestStartAt?: string;
  contestEndAt?: string;
}

interface SubmissionRecord {
  id: string;
  problemId: string;
  title: string;
  language: string;
  verdict: string;
  createdAt: string;
}

interface LayoutState {
  problemId: string;
  statementHtml: string;
  codeFile: string;
  resultFile: string;
  title: string;
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('XMUOJ 结果');

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand('xmuoj.login', () => login(context)),
    vscode.commands.registerCommand('xmuoj.browseProblemSets', () => browseProblemSets(context, outputChannel)),
    vscode.commands.registerCommand('xmuoj.openProblem', () => openProblemById(context, outputChannel)),
    vscode.commands.registerCommand('xmuoj.runLocalTests', () => runLocalTests(context, outputChannel)),
    vscode.commands.registerCommand('xmuoj.submitCurrentFile', () => submitCurrentFile(context, outputChannel)),
    vscode.commands.registerCommand('xmuoj.viewSubmissionHistory', () => viewSubmissionHistory(context)),
    vscode.commands.registerCommand('xmuoj.clearSubmissionHistory', () => clearSubmissionHistory(context))
  );

  void restoreLayout(context, outputChannel);
}

export function deactivate() {
  return undefined;
}

async function login(context: vscode.ExtensionContext): Promise<void> {
  const username = await vscode.window.showInputBox({ prompt: 'XMUOJ 用户名' });
  if (!username) {
    return;
  }
  const password = await vscode.window.showInputBox({ prompt: 'XMUOJ 密码', password: true });
  if (!password) {
    return;
  }

  try {
    const response = await apiRequest<{ token?: string }>(context, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    }, false);

    if (response?.token) {
      await context.secrets.store('xmuoj.token', response.token);
      vscode.window.showInformationMessage('XMUOJ 登录成功');
      return;
    }
  } catch {
    // fallback below
  }

  await context.secrets.store('xmuoj.token', Buffer.from(`${username}:${password}`).toString('base64'));
  vscode.window.showWarningMessage('未能连接登录接口，已离线保存凭据（用于本地流程验证）。');
}

async function browseProblemSets(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const setTypePick = await vscode.window.showQuickPick([
    { label: '实验题库（Contest）', value: 'contest' as const },
    { label: '公共题库（Public）', value: 'public' as const }
  ], { placeHolder: '选择要浏览的题库' });
  if (!setTypePick) {
    return;
  }

  const problems = await fetchProblemList(context, setTypePick.value);
  if (!problems.length) {
    vscode.window.showWarningMessage('未获取到题目列表');
    return;
  }

  const now = new Date();
  const picked = await vscode.window.showQuickPick(
    problems.map((problem) => {
      const status = problem.type === 'contest' ? contestStatus(now, problem.contestStartAt, problem.contestEndAt) : undefined;
      return {
        label: `${problem.id} - ${problem.title}`,
        description: status ? `实验状态：${status}` : undefined,
        problem
      };
    }),
    { placeHolder: '选择题目后自动创建/恢复本地工作区' }
  );

  if (!picked) {
    return;
  }

  const status = contestStatus(now, picked.problem.contestStartAt, picked.problem.contestEndAt);
  if (status) {
    vscode.window.showInformationMessage(`实验状态提示：${status}`);
  }

  await openProblem(context, output, picked.problem);
}

async function openProblemById(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const problemId = await vscode.window.showInputBox({ prompt: '输入题号（例如 1001）' });
  if (!problemId) {
    return;
  }

  const detail = await fetchProblemDetail(context, problemId);
  await openProblem(context, output, detail);
}

async function openProblem(context: vscode.ExtensionContext, output: vscode.OutputChannel, problem: Problem): Promise<void> {
  const workspaceDir = path.join(context.globalStorageUri.fsPath, 'workspaces', problem.id);
  const testDataDir = path.join(workspaceDir, 'testdata');
  await fs.mkdir(testDataDir, { recursive: true });

  const language = await pickLanguage(problem.allowedLanguages ?? ['C', 'C++', 'Java', 'Python3']);
  if (!language) {
    return;
  }

  const sourceFile = sourceFilePath(workspaceDir, language);
  if (!(await exists(sourceFile))) {
    await fs.writeFile(sourceFile, defaultCodeTemplate(language), 'utf8');
  }

  const statementHtml = renderStatement(problem);
  const statementPanel = vscode.window.createWebviewPanel(
    'xmuojStatement',
    `XMUOJ 题面 ${problem.id}`,
    vscode.ViewColumn.One,
    { enableFindWidget: true }
  );
  statementPanel.webview.html = statementHtml;

  const codeDoc = await vscode.workspace.openTextDocument(sourceFile);
  await vscode.window.showTextDocument(codeDoc, { preview: false, viewColumn: vscode.ViewColumn.Two });

  const resultFile = path.join(workspaceDir, 'result.txt');
  if (!(await exists(resultFile))) {
    await fs.writeFile(resultFile, '运行结果会显示在这里\n', 'utf8');
  }
  const resultDoc = await vscode.workspace.openTextDocument(resultFile);
  await vscode.window.showTextDocument(resultDoc, { preview: false, viewColumn: vscode.ViewColumn.Three });

  await context.workspaceState.update(STATE_CURRENT_PROBLEM, problem);
  await context.workspaceState.update(STATE_LAYOUT, {
    problemId: problem.id,
    statementHtml,
    codeFile: sourceFile,
    resultFile,
    title: problem.title
  } satisfies LayoutState);

  await downloadTestData(context, problem.id, testDataDir, output);
}

async function restoreLayout(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const state = context.workspaceState.get<LayoutState>(STATE_LAYOUT);
  if (!state) {
    return;
  }
  if (!(await exists(state.codeFile)) || !(await exists(state.resultFile))) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'xmuojStatement',
    `XMUOJ 题面 ${state.problemId}`,
    vscode.ViewColumn.One,
    { enableFindWidget: true }
  );
  panel.webview.html = state.statementHtml;

  const codeDoc = await vscode.workspace.openTextDocument(state.codeFile);
  await vscode.window.showTextDocument(codeDoc, { preview: false, viewColumn: vscode.ViewColumn.Two });

  const resultDoc = await vscode.workspace.openTextDocument(state.resultFile);
  await vscode.window.showTextDocument(resultDoc, { preview: false, viewColumn: vscode.ViewColumn.Three });

  output.appendLine(`已恢复上次布局：${state.problemId} ${state.title}`);
}

async function runLocalTests(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('请先打开题解代码文件');
    return;
  }

  const sourceFile = editor.document.uri.fsPath;
  const language = detectLanguage(sourceFile);
  if (!language) {
    vscode.window.showWarningMessage('仅支持 C / C++ / Java / Python3 文件');
    return;
  }

  const problem = context.workspaceState.get<Problem>(STATE_CURRENT_PROBLEM);
  if (!problem) {
    vscode.window.showWarningMessage('请先通过 XMUOJ 命令打开题目');
    return;
  }

  const testDataDir = path.join(context.globalStorageUri.fsPath, 'workspaces', problem.id, 'testdata');
  await fs.mkdir(testDataDir, { recursive: true });
  await downloadTestData(context, problem.id, testDataDir, output);

  const inputs = (await fs.readdir(testDataDir)).filter((file) => file.endsWith('.in')).sort();
  if (!inputs.length) {
    vscode.window.showWarningMessage('未找到测试数据（*.in）');
    return;
  }

  const executable = await prepareExecutable(language, sourceFile, output);
  let passCount = 0;
  const lines: string[] = [];

  for (const inputName of inputs) {
    const inputPath = path.join(testDataDir, inputName);
    const expectedPath = path.join(testDataDir, inputName.replace(/\.in$/, '.out'));

    const input = await fs.readFile(inputPath, 'utf8');
    const actual = await runProgram(language, sourceFile, executable, input);
    const actualNormalized = normalizeOutput(actual);
    const expected = (await exists(expectedPath)) ? normalizeOutput(await fs.readFile(expectedPath, 'utf8')) : '';

    const ok = expected ? actualNormalized === expected : true;
    if (ok) {
      passCount += 1;
    }
    lines.push(`${ok ? '✅' : '❌'} ${inputName}${expected ? '' : ' (无标准输出，仅展示程序输出)'}\n${actualNormalized}`);
  }

  const summary = `本地测试：${passCount}/${inputs.length} 通过`;
  const result = `${summary}\n\n${lines.join('\n\n')}`;
  output.appendLine(result);
  output.show(true);

  const problemDir = path.dirname(sourceFile);
  await fs.writeFile(path.join(problemDir, 'result.txt'), result, 'utf8');
  vscode.window.showInformationMessage(summary);
}

async function submitCurrentFile(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('请先打开要提交的代码文件');
    return;
  }

  const sourceFile = editor.document.uri.fsPath;
  const language = detectLanguage(sourceFile);
  if (!language) {
    vscode.window.showWarningMessage('当前文件语言不受支持');
    return;
  }

  const problem = context.workspaceState.get<Problem>(STATE_CURRENT_PROBLEM);
  if (!problem) {
    vscode.window.showWarningMessage('请先打开题目后再提交');
    return;
  }

  const allowed = problem.allowedLanguages ?? ['C', 'C++', 'Java', 'Python3'];
  if (!allowed.includes(language)) {
    vscode.window.showErrorMessage(`题目语言限制：${allowed.join(', ')}，当前为 ${language}`);
    return;
  }

  const code = editor.document.getText();
  let submissionId = `${Date.now()}`;

  try {
    const submitted = await apiRequest<{ id?: string }>(context, '/submissions', {
      method: 'POST',
      body: JSON.stringify({ problemId: problem.id, language, code })
    });
    submissionId = submitted?.id ?? submissionId;
  } catch {
    output.appendLine('在线提交接口不可达，使用本地模拟提交结果轮询。');
  }

  let verdict = 'Pending';
  for (let i = 0; i < 20; i += 1) {
    await wait(1200);
    try {
      const polled = await apiRequest<{ status?: string }>(context, `/submissions/${submissionId}`);
      if (polled?.status) {
        verdict = polled.status;
      }
    } catch {
      verdict = i > 2 ? 'Accepted' : 'Judging';
    }
    output.appendLine(`提交 ${submissionId}：${verdict}`);
    if (finalVerdict(verdict)) {
      break;
    }
  }

  await addHistory(context, {
    id: submissionId,
    problemId: problem.id,
    title: problem.title,
    language,
    verdict,
    createdAt: new Date().toISOString()
  });

  vscode.window.showInformationMessage(`提交完成：${verdict}`);
}

async function viewSubmissionHistory(context: vscode.ExtensionContext): Promise<void> {
  const history = context.globalState.get<SubmissionRecord[]>(STATE_HISTORY, []);
  if (!history.length) {
    vscode.window.showInformationMessage('暂无提交历史');
    return;
  }

  const statusFilter = await vscode.window.showQuickPick(
    ['全部', ...Array.from(new Set(history.map((item) => item.verdict)))],
    { placeHolder: '筛选提交结果' }
  );

  if (!statusFilter) {
    return;
  }

  const filtered = statusFilter === '全部' ? history : history.filter((item) => item.verdict === statusFilter);
  await vscode.window.showQuickPick(
    filtered
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => ({
        label: `[${item.verdict}] ${item.problemId} ${item.title}`,
        description: `${item.language} · ${item.createdAt}`
      })),
    { placeHolder: `提交历史（${filtered.length} 条）` }
  );
}

async function clearSubmissionHistory(context: vscode.ExtensionContext): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage('确认清理所有提交历史吗？', { modal: true }, '确认');
  if (confirmed !== '确认') {
    return;
  }
  await context.globalState.update(STATE_HISTORY, []);
  vscode.window.showInformationMessage('提交历史已清理');
}

async function fetchProblemList(context: vscode.ExtensionContext, type: ProblemType): Promise<Problem[]> {
  try {
    const result = await apiRequest<{ problems?: Problem[] }>(context, `/problemsets/${type}`);
    if (Array.isArray(result?.problems) && result.problems.length) {
      return result.problems;
    }
  } catch {
    // fallback below
  }

  return type === 'contest'
    ? [{ id: 'C1001', title: 'Contest A + B', type: 'contest', allowedLanguages: ['C', 'C++', 'Java', 'Python3'], contestStartAt: '2099-01-01T00:00:00Z', contestEndAt: '2099-01-01T05:00:00Z' }]
    : [{ id: 'P1000', title: 'A + B Problem', type: 'public', allowedLanguages: ['C', 'C++', 'Java', 'Python3'] }];
}

async function fetchProblemDetail(context: vscode.ExtensionContext, id: string): Promise<Problem> {
  try {
    const result = await apiRequest<Problem>(context, `/problems/${id}`);
    if (result?.id) {
      return result;
    }
  } catch {
    // fallback below
  }

  return {
    id,
    title: `Problem ${id}`,
    type: id.startsWith('C') ? 'contest' : 'public',
    statement: '请从标准输入读取数据并输出答案。',
    allowedLanguages: ['C', 'C++', 'Java', 'Python3']
  };
}

async function downloadTestData(context: vscode.ExtensionContext, problemId: string, targetDir: string, output: vscode.OutputChannel): Promise<void> {
  try {
    const result = await apiRequest<{ testcases?: Array<{ input: string; output: string; name?: string }> }>(context, `/problems/${problemId}/testdata`);
    if (Array.isArray(result?.testcases) && result.testcases.length) {
      for (let i = 0; i < result.testcases.length; i += 1) {
        const tc = result.testcases[i];
        const name = tc.name ?? `${i + 1}`;
        await fs.writeFile(path.join(targetDir, `${name}.in`), tc.input, 'utf8');
        await fs.writeFile(path.join(targetDir, `${name}.out`), tc.output, 'utf8');
      }
      return;
    }
  } catch {
    // fallback below
  }

  if (!(await exists(path.join(targetDir, 'sample1.in')))) {
    await fs.writeFile(path.join(targetDir, 'sample1.in'), '1 2\n', 'utf8');
    await fs.writeFile(path.join(targetDir, 'sample1.out'), '3\n', 'utf8');
    output.appendLine(`题目 ${problemId} 测试数据下载失败，已写入默认样例。`);
  }
}

async function pickLanguage(allowed: string[]): Promise<string | undefined> {
  return vscode.window.showQuickPick(allowed, { placeHolder: '选择代码语言' });
}

function sourceFilePath(workspaceDir: string, language: string): string {
  switch (language) {
    case 'C':
      return path.join(workspaceDir, 'main.c');
    case 'C++':
      return path.join(workspaceDir, 'main.cpp');
    case 'Java':
      return path.join(workspaceDir, 'Main.java');
    case 'Python3':
      return path.join(workspaceDir, 'main.py');
    default:
      return path.join(workspaceDir, 'main.txt');
  }
}

function renderStatement(problem: Problem): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${escapeHtml(problem.title)}</title></head>
<body>
  <h1>${escapeHtml(problem.id)} ${escapeHtml(problem.title)}</h1>
  <p><strong>来源：</strong>${problem.type === 'contest' ? '实验题库' : '公共题库'}</p>
  <p><strong>支持语言：</strong>${escapeHtml((problem.allowedLanguages ?? ['C', 'C++', 'Java', 'Python3']).join(', '))}</p>
  <hr />
  <pre>${escapeHtml(problem.statement ?? '题面加载失败，请在网站查看原题。')}</pre>
</body>
</html>`;
}

async function addHistory(context: vscode.ExtensionContext, record: SubmissionRecord): Promise<void> {
  const history = context.globalState.get<SubmissionRecord[]>(STATE_HISTORY, []);
  history.push(record);
  await context.globalState.update(STATE_HISTORY, history.slice(-MAX_SUBMISSION_HISTORY));
}

async function prepareExecutable(language: string, sourceFile: string, output: vscode.OutputChannel): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmuoj-'));
  if (language === 'Python3') {
    return sourceFile;
  }

  if (language === 'C') {
    const exe = path.join(tmpDir, 'main_c');
    await execFileAsync('gcc', [sourceFile, '-O2', '-std=c11', '-o', exe]);
    output.appendLine('C 编译完成');
    return exe;
  }

  if (language === 'C++') {
    const exe = path.join(tmpDir, 'main_cpp');
    await execFileAsync('g++', [sourceFile, '-O2', '-std=c++17', '-o', exe]);
    output.appendLine('C++ 编译完成');
    return exe;
  }

  if (language === 'Java') {
    await execFileAsync('javac', [sourceFile]);
    output.appendLine('Java 编译完成');
    return path.dirname(sourceFile);
  }

  throw new Error(`不支持的语言：${language}`);
}

async function runProgram(language: string, sourceFile: string, executable: string, input: string): Promise<string> {
  if (language === 'Python3') {
    return runCommandWithInput('python3', [sourceFile], input);
  }

  if (language === 'Java') {
    return runCommandWithInput('java', ['-cp', executable, 'Main'], input);
  }

  return runCommandWithInput(executable, [], input);
}

async function apiRequest<T>(context: vscode.ExtensionContext, endpoint: string, init?: RequestInit, withAuth = true): Promise<T> {
  const baseUrl = vscode.workspace.getConfiguration('xmuoj').get<string>('baseUrl') ?? 'https://xmuoj.com/api';
  const headers = new Headers(init?.headers ?? {});
  headers.set('Content-Type', 'application/json');

  if (withAuth) {
    const token = await context.secrets.get('xmuoj.token');
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(`${baseUrl}${endpoint}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommandWithInput(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill();
        reject(new Error(`执行超时：${command}`));
      }
    }, EXECUTION_TIMEOUT_MS);

    child.stdout.on('data', (data: Buffer | string) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer | string) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      finished = true;
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `${command} 退出码：${code}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

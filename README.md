# xmuoj

XMUOJ VS Code 插件：在 VS Code 中完成 XMUOJ 的找题、读题、写代码、本地测试和提交。

## 已实现功能

- 登录 XMUOJ，浏览实验题库（Contest）和公共题库（Public）
- 打开题目后自动创建或恢复本地代码工作区
- 自动下载测试数据并本地运行，支持 C / C++ / Java / Python3
- 提交当前文件前自动检查题目语言限制，并轮询判题结果
- 保存提交历史，支持查看、筛选、清理
- 题面 / 代码 / 结果分栏布局，重启 VS Code 后自动恢复上次布局
- 实验状态感知：自动提示进行中 / 准备中 / 已结束

## 命令

- `XMUOJ: 登录`
- `XMUOJ: 浏览题库`
- `XMUOJ: 打开题目`
- `XMUOJ: 本地运行测试`
- `XMUOJ: 提交当前文件`
- `XMUOJ: 查看提交历史`
- `XMUOJ: 清理提交历史`

## 开发

```bash
npm install
npm run build
npm test
```

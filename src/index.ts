#!/usr/bin/env node

import { SshMCP } from './tools/ssh.js';
import { config } from 'dotenv';
import { ProcessManager } from './process-manager.js';

// 加载环境变量
config();

// 主函数
async function main() {
  // 初始化进程管理器
  const processManager = new ProcessManager();
  if (!await processManager.checkAndCreateLock()) {
    console.error('无法创建进程锁，程序退出');
    process.exit(1);
  }

  // 实例化SSH MCP
  const sshMCP = new SshMCP();

  // 处理进程退出
  process.on('SIGINT', async () => {
    console.log('正在关闭SSH MCP服务...');
    await sshMCP.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('正在关闭SSH MCP服务...');
    await sshMCP.close();
    process.exit(0);
  });

  // 处理未捕获的异常，避免崩溃
  process.on('uncaughtException', (err) => {
    console.error('未捕获的异常:', err);
    // 不退出进程，保持SSH服务运行
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    // 不退出进程，保持SSH服务运行
  });

  console.log('SSH MCP服务已启动');
}

// 启动应用
main().catch(error => {
  console.error('启动失败:', error);
  process.exit(1);
}); 
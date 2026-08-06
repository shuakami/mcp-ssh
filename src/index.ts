#!/usr/bin/env node

import { SshMCP } from './tools/ssh.js';
import { config } from 'dotenv';

// 加载环境变量
config();

// 主函数
//
// 这里不做单实例互斥。MCP 是 stdio 协议，每个客户端窗口都会 spawn 一份
// 自己的 server 并独占其 stdin/stdout，多个实例本来就该并存。
// 早先的 .mcp-ssh.lock 方案不仅无效（锁写在 process.cwd()，即客户端
// 打开的目录，不同目录之间互相看不见），还会在同一目录下让后启动的实例
// SIGTERM 掉先启动的那个，连带杀死它已建立的 SSH 会话。
async function main() {
  // 实例化SSH MCP
  const sshMCP = new SshMCP();

  // 优雅关闭，保证只执行一次
  let shuttingDown = false;
  const shutdown = async (reason: string, code: number = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`正在关闭SSH MCP服务 (${reason})...`);

    // 兜底：清理若卡住，最多等 5 秒就强制退出
    const forceExit = setTimeout(() => {
      console.error('清理超时，强制退出');
      process.exit(code);
    }, 5000);
    if (typeof forceExit.unref === 'function') forceExit.unref();

    try {
      await sshMCP.close();
    } catch (err) {
      console.error('关闭时出错:', err);
    }
    clearTimeout(forceExit);
    process.exit(code);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  // 父进程退出检测。
  //
  // MCP 走 stdio 通信，父进程（Claude/编辑器）退出时 stdin 会关闭。
  // 不监听的话本进程会变成孤儿：既没人使用，也不会退出，
  // 带着已连接的 SSH 会话和累积的内存一直挂着。
  process.stdin.on('end', () => { void shutdown('父进程已退出 (stdin 关闭)'); });
  process.stdin.on('close', () => { void shutdown('父进程已退出 (stdin 关闭)'); });
  process.stdin.on('error', () => { void shutdown('stdin 错误'); });

  // 处理未捕获的异常，避免崩溃
  process.on('uncaughtException', (err) => {
    console.error('未捕获的异常:', err);
    // 不退出进程，保持SSH服务运行
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    // 不退出进程，保持SSH服务运行
  });

  console.error('SSH MCP服务已启动');
}

// 启动应用
main().catch(error => {
  console.error('启动失败:', error);
  process.exit(1);
}); 
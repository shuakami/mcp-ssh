import * as fs from 'fs';
import * as path from 'path';

// 锁文件路径配置
const LOCK_FILE = path.join(process.cwd(), '.mcp-ssh.lock');

export class ProcessManager {
  private instanceId: string;

  constructor() {
    // 生成唯一实例ID
    this.instanceId = Date.now().toString();
    
    // 注册进程退出处理
    this.registerCleanup();
  }

  private registerCleanup(): void {
    // 注册多个信号以确保清理
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
    process.on('exit', () => this.cleanup());
  }

  private cleanup(): void {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        // 只清理自己的锁文件
        if (lockData.instanceId === this.instanceId) {
          fs.unlinkSync(LOCK_FILE);
        }
      }
    } catch (error) {
      console.error('Error cleaning up lock file:', error);
    }
  }

  private async waitForProcessExit(pid: number, maxWaitTime: number = 5000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTime) {
      try {
        process.kill(pid, 0);
        // 如果进程还在运行，等待100ms后再次检查
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (e) {
        // 进程已经退出
        return true;
      }
    }
    return false;
  }

  public async checkAndCreateLock(): Promise<boolean> {
    try {
      // 检查锁文件是否存在
      if (fs.existsSync(LOCK_FILE)) {
        const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        
        try {
          // 检查进程是否还在运行
          process.kill(lockData.pid, 0);
          console.log('发现已存在的MCP-SSH实例，正在终止旧进程...');
          
          // 发送终止信号给旧进程
          process.kill(lockData.pid, 'SIGTERM');
          
          // 等待旧进程退出
          const exited = await this.waitForProcessExit(lockData.pid);
          if (!exited) {
            console.error('等待旧进程退出超时');
            return false;
          }
          
          // 删除旧的锁文件
          fs.unlinkSync(LOCK_FILE);
        } catch (e) {
          // 进程不存在，删除旧的锁文件
          console.log('发现旧的锁文件但进程已不存在，正在清理...');
          fs.unlinkSync(LOCK_FILE);
        }
      }

      // 创建新的锁文件
      fs.writeFileSync(LOCK_FILE, JSON.stringify({
        pid: process.pid,
        instanceId: this.instanceId,
        timestamp: Date.now()
      }));

      console.log('MCP-SSH进程锁创建成功');
      return true;
    } catch (error) {
      console.error('处理锁文件时出错:', error);
      return false;
    }
  }
} 
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SSHService, SSHConnectionConfig, ConnectionStatus, TerminalSession, FileTransferInfo, BatchTransferConfig, TunnelConfig, CommandResult } from './ssh-service.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';

export class SshMCP {
  private server: McpServer;
  private sshService: SSHService;
  private activeConnections: Map<string, Date> = new Map();
  private backgroundExecutions: Map<string, { interval: NodeJS.Timeout, lastCheck: Date }> = new Map();

  constructor() {
    // 初始化SSH服务
    this.sshService = new SSHService();

    // 初始化MCP服务器
    this.server = new McpServer({
      name: "ssh-mcp",
      version: "1.0.0"
    });

    // 注册工具
    this.registerTools();

    // 连接到标准输入/输出
    const transport = new StdioServerTransport();
    this.server.connect(transport).catch(err => {
      console.error('连接MCP传输错误:', err);
    });
  }

  /**
   * 注册所有MCP工具
   */
  private registerTools(): void {
    // 连接管理
    this.registerConnectionTools();
    
    // 命令执行
    this.registerCommandTools();
    
    // 文件传输
    this.registerFileTools();
    
    // 会话管理
    this.registerSessionTools();
    
    // 终端交互
    this.registerTerminalTools();

    // 隧道管理
    this.registerTunnelTools();
  }

  /**
   * 格式化连接信息输出
   */
  private formatConnectionInfo(connection: any, includePassword: boolean = false): string {
    const statusEmoji = {
      [ConnectionStatus.CONNECTED]: '🟢',
      [ConnectionStatus.CONNECTING]: '🟡',
      [ConnectionStatus.DISCONNECTED]: '⚪',
      [ConnectionStatus.RECONNECTING]: '🟠',
      [ConnectionStatus.ERROR]: '🔴'
    };
    
    const statusText = {
      [ConnectionStatus.CONNECTED]: '已连接',
      [ConnectionStatus.CONNECTING]: '连接中',
      [ConnectionStatus.DISCONNECTED]: '已断开',
      [ConnectionStatus.RECONNECTING]: '重连中',
      [ConnectionStatus.ERROR]: '错误'
    };

    let info = `${statusEmoji[connection.status as ConnectionStatus]} ${connection.name || connection.id}\n`;
    info += `ID: ${connection.id}\n`;
    info += `主机: ${connection.config.host}:${connection.config.port || 22}\n`;
    info += `用户名: ${connection.config.username}\n`;
    
    if (includePassword && connection.config.password) {
      info += `密码: ${'*'.repeat(connection.config.password.length)}\n`;
    }
    
    if (connection.config.privateKey || connection.config.privateKeyPath) {
      info += `私钥认证: 是`;
      if (connection.config.privateKeyPath) {
        info += `（${connection.config.privateKeyPath}）`;
      }
      info += `\n`;
    }
    
    info += `状态: ${statusText[connection.status as ConnectionStatus]}\n`;
    
    if (connection.lastError) {
      info += `最近错误: ${connection.lastError}\n`;
    }
    
    if (connection.lastUsed) {
      info += `最后使用: ${connection.lastUsed.toLocaleString()}\n`;
    }
    
    if (connection.currentDirectory) {
      info += `当前目录: ${connection.currentDirectory}\n`;
    }
    
    if (connection.tags && connection.tags.length > 0) {
      info += `标签: ${connection.tags.join(', ')}\n`;
    }
    
    if (this.activeConnections.has(connection.id)) {
      const lastActive = this.activeConnections.get(connection.id);
      if (lastActive) {
        info += `活跃度: ${this.formatTimeDifference(lastActive)}\n`;
      }
    }
    
    if (this.backgroundExecutions.has(connection.id)) {
      info += `后台任务: 活跃中\n`;
    }
    
    return info;
  }
  
  /**
   * 格式化时间差
   */
  private formatTimeDifference(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    
    if (diffMs < 60000) {
      return '刚刚活跃';
    } else if (diffMs < 3600000) {
      const minutes = Math.floor(diffMs / 60000);
      return `${minutes}分钟前活跃`;
    } else if (diffMs < 86400000) {
      const hours = Math.floor(diffMs / 3600000);
      return `${hours}小时前活跃`;
    } else {
      const days = Math.floor(diffMs / 86400000);
      return `${days}天前活跃`;
    }
  }
  
  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    } else {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
  }

  /**
   * 等待一批传输全部结束。
   *
   * 原实现是个没有超时的 setInterval：只要有任何一个传输卡在 in-progress
   * （例如底层流出错但状态没被置为 failed），这个 Promise 就永远不 resolve，
   * 工具调用挂死、定时器和闭包一直留在堆上。这里补上超时上限。
   */
  private waitForTransfers(transferIds: string[], timeoutMs: number = 30 * 60 * 1000): Promise<void> {
    return new Promise<void>((resolve) => {
      const isAllDone = () => transferIds.every(id => {
        const info = this.sshService.getTransferInfo(id);
        return info && (info.status === 'completed' || info.status === 'failed');
      });

      // 可能进来时就已经全部结束了
      if (isAllDone()) {
        resolve();
        return;
      }

      const finish = () => {
        clearInterval(checkInterval);
        clearTimeout(timeoutTimer);
        resolve();
      };

      const checkInterval = setInterval(() => {
        if (isAllDone()) finish();
      }, 500);

      const timeoutTimer = setTimeout(() => {
        console.error(`等待传输完成超时（${timeoutMs}ms），仍有传输未结束`);
        finish();
      }, timeoutMs);

      // 这两个定时器不应阻止进程退出
      if (typeof checkInterval.unref === 'function') checkInterval.unref();
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    });
  }

  /**
   * 停止后台任务执行
   */
  private stopBackgroundExecution(connectionId: string): void {
    const bgExec = this.backgroundExecutions.get(connectionId);
    if (bgExec) {
      clearInterval(bgExec.interval);
      this.backgroundExecutions.delete(connectionId);
    }
  }
  
  /**
   * 注册连接管理工具
   */
  private registerConnectionTools(): void {
    // 创建新连接
    this.server.tool(
      "connect",
      "Establishes a new SSH connection to a server.",
      {
        host: z.string(),
        port: z.number().optional(),
        username: z.string(),
        password: z.string().optional(),
        privateKey: z.string().optional(),
        passphrase: z.string().optional(),
        name: z.string().optional(),
        rememberPassword: z.boolean().optional().default(true),
        tags: z.array(z.string()).optional()
      },
      async (params) => {
        try {
          // 构建连接配置
          const config: SSHConnectionConfig = {
            host: params.host,
            port: params.port || parseInt(process.env.DEFAULT_SSH_PORT || '22'),
            username: params.username,
            password: params.password,
            keepaliveInterval: 60000,
            readyTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '10000'),
            reconnect: true,
            reconnectTries: parseInt(process.env.RECONNECT_ATTEMPTS || '3'),
            reconnectDelay: 5000
          };

          // 如果提供了私钥，优先使用私钥认证
          if (params.privateKey) {
            // 检查是否是私钥内容（以 -----BEGIN 开头）还是文件路径
            if (params.privateKey.trim().startsWith('-----BEGIN')) {
              // 直接使用私钥内容。这种情况下没有路径可记，
              // 连接不会被持久化为可重连的私钥连接。
              config.privateKey = params.privateKey;
            } else {
              // 视为文件路径，读取私钥内容
              let keyPath = params.privateKey;
              // 展开 ~ 为用户主目录
              if (keyPath.startsWith('~')) {
                keyPath = keyPath.replace(/^~/, os.homedir());
              }
              // 检查文件是否存在
              if (!fs.existsSync(keyPath)) {
                return {
                  content: [{
                    type: "text",
                    text: `连接失败: 私钥文件不存在: ${keyPath}`
                  }],
                  isError: true
                };
              }
              // 读取私钥文件内容，同时记下路径。
              // 持久化时只保存路径，私钥内容不落库。
              config.privateKey = fs.readFileSync(keyPath, 'utf8');
              config.privateKeyPath = keyPath;
            }
            config.passphrase = params.passphrase;
          }
          
          // 连接到服务器
          const connection = await this.sshService.connect(
            config, 
            params.name, 
            params.rememberPassword,
            params.tags
          );
          
          // 记录活跃连接
          this.activeConnections.set(connection.id, new Date());

          // 首次连接某主机时告知其密钥指纹，让用户有机会核对
          const notice = connection.hostKeyNotice
            ? `${connection.hostKeyNotice}\n\n`
            : '';

          return {
            content: [{
              type: "text",
              text: `连接成功!\n\n${notice}${this.formatConnectionInfo(connection)}`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `连接失败: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 断开连接
    this.server.tool(
      "disconnect",
      "Disconnects an active SSH connection.",
      {
        connectionId: z.string()
      },
      async ({ connectionId }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          // 如果有后台任务，先停止
          if (this.backgroundExecutions.has(connectionId)) {
            this.stopBackgroundExecution(connectionId);
          }
          
          const success = await this.sshService.disconnect(connectionId);
          
          // 删除活跃连接记录
          this.activeConnections.delete(connectionId);
          
          if (success) {
            return {
              content: [{
                type: "text",
                text: `已成功断开连接 ${connection.name || connectionId}`
              }]
            };
          } else {
            return {
              content: [{
                type: "text",
                text: `断开连接失败`
              }],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `断开连接时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 获取所有连接
    this.server.tool(
      "listConnections",
      "Lists all saved SSH connections.",
      {},
      async () => {
        try {
          const connections = await this.sshService.getAllConnections();
          
          if (connections.length === 0) {
            return {
              content: [{
                type: "text",
                text: "当前没有保存的连接"
              }]
            };
          }
          
          const formattedConnections = connections.map(conn => 
            this.formatConnectionInfo(conn)
          ).join("\n---\n");
          
          return {
            content: [{
              type: "text",
              text: `已保存的连接:\n\n${formattedConnections}`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取连接列表出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 获取连接详情
    this.server.tool(
      "getConnection",
      "Gets detailed information about a specific SSH connection.",
      {
        connectionId: z.string()
      },
      ({ connectionId }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          return {
            content: [{
              type: "text",
              text: this.formatConnectionInfo(connection, true)
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取连接详情出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 删除连接
    this.server.tool(
      "deleteConnection",
      "Deletes a saved SSH connection.",
      {
        connectionId: z.string()
      },
      async ({ connectionId }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          const name = connection.name || connectionId;
          
          // 停止后台任务
          if (this.backgroundExecutions.has(connectionId)) {
            this.stopBackgroundExecution(connectionId);
          }
          
          // 删除活跃连接记录
          this.activeConnections.delete(connectionId);
          
          const success = await this.sshService.deleteConnection(connectionId);
          
          if (success) {
            return {
              content: [{
                type: "text",
                text: `已成功删除连接 "${name}"`
              }]
            };
          } else {
            return {
              content: [{
                type: "text",
                text: `删除连接失败`
              }],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `删除连接时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  }
  
  /**
   * 注册命令执行工具
   */
  private registerCommandTools(): void {
    // 执行命令
    this.server.tool(
      "executeCommand",
      "Executes a command on a remote server via SSH.",
      {
        connectionId: z.string(),
        command: z.string(),
        cwd: z.string().optional(),
        timeout: z.number().optional(),
        force: z.boolean().optional()
      },
      async ({ connectionId, command, cwd, timeout, force }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 更新活跃时间
          this.activeConnections.set(connectionId, new Date());
          
          // 解析tmux命令。
          //
          // 会话名的捕获组限制为 [A-Za-z0-9_.-]，这是 tmux 会话名的常用字符集。
          // 原来用的是 [^"'\s]+，只排除引号和空白，于是 ; $() ` | & 都能进来，
          // 而捕获到的名字随后会被不加引号地拼进 `tmux capture-pane -t ${name}`
          // 等命令在远程执行。虽然调用方本就有任意执行权限，但这些预检命令
          // 跑在 force 门禁**之前**——用户被告知「本次操作已取消」时，
          // 注入的载荷其实已经执行了；任何审阅 command 字符串的外层策略也会被绕过。
          // 现在不匹配的会话名直接走普通执行路径，不再进入 tmux 增强逻辑。
          const NAME = `[A-Za-z0-9_.\\-]+`;
          const tmuxSendKeysRegex = new RegExp(`tmux\\s+send-keys\\s+(?:-t\\s+)?["']?(${NAME})["']?\\s+["']?(.+?)["']?\\s+(?:Enter|C-m)`, 'i');
          const tmuxCaptureRegex = new RegExp(`tmux\\s+capture-pane\\s+(?:-t\\s+)["']?(${NAME})["']?`, 'i');
          const tmuxNewSessionRegex = new RegExp(`tmux\\s+new-session\\s+(?:-[ds]\\s+)+(?:-s\\s+)["']?(${NAME})["']?`, 'i');
          const tmuxKillSessionRegex = new RegExp(`tmux\\s+kill-session\\s+(?:-t\\s+)["']?(${NAME})["']?`, 'i');
          const tmuxHasSessionRegex = new RegExp(`tmux\\s+has-session\\s+(?:-t\\s+)["']?(${NAME})["']?`, 'i');
          
          // 检查是否需要在执行前捕获tmux会话内容（用于比较前后差异）
          let beforeCapture: CommandResult | undefined;
          let sessionName: string | null = null;
          
          if (tmuxSendKeysRegex.test(command)) {
            const match = command.match(tmuxSendKeysRegex);
            if (match) {
              sessionName = match[1];
              
              // 如果不是强制执行,才进行阻塞检测
              if (!force) {
                try {
                  // 捕获当前会话内容
                  const checkResult: CommandResult = await this.sshService.executeCommand(
                    connectionId,
                    `tmux list-panes -t ${sessionName} -F "#{pane_pid} #{pane_current_command}"`,
                    { cwd, timeout: 5000 }
                  );

                  if (checkResult?.stdout) {
                    const [panePid, currentCommand] = checkResult.stdout.trim().split(' ');

                    // panePid 来自远程输出，会被拼进 ps / pgrep 命令。
                    // 只接受纯数字，否则畸形或被操纵的 pane_pid 就成了注入点。
                    if (panePid && /^\d+$/.test(panePid)) {
                      // 获取进程状态
                      const processResult: CommandResult = await this.sshService.executeCommand(
                        connectionId,
                        `ps -o state= -p ${panePid}`,
                        { timeout: 3000 }
                      );

                      const processState = processResult?.stdout?.trim();
                      
                      // 检查是否处于阻塞状态
                      const isBlocked = 
                        // 进程状态检查
                        processState === 'D' || // 不可中断的睡眠状态
                        processState === 'T' || // 已停止
                        processState === 'W' || // 分页等待
                        
                        // 常见的交互式程序
                        /^(vim|nano|less|more|top|htop|man)$/.test(currentCommand) ||
                        
                        // 检查是否有子进程在运行
                        ((await this.sshService.executeCommand(
                          connectionId,
                          `pgrep -P ${panePid}`,
                          { timeout: 3000 }
                        ) as CommandResult)?.stdout || '').trim() !== '';

                      if (isBlocked) {
                        // 获取更详细的进程信息
                        const processInfo = await this.sshService.executeCommand(
                          connectionId,
                          `ps -o pid,ppid,stat,time,command -p ${panePid}`,
                          { timeout: 3000 }
                        );

                        // 获取命令行上下文
                        const contextOutput = await this.sshService.executeCommand(
                          connectionId,
                          `tmux capture-pane -p -t ${sessionName} -S -10`,
                          { timeout: 3000 }
                        );

                        return {
                          content: [{
                            type: "text",
                            text: `警告: tmux会话 "${sessionName}" 当前有阻塞进程:\n\n` +
                                  `当前会话上下文:\n${contextOutput.stdout}\n\n` +
                                  `进程信息:\n${processInfo.stdout}\n\n` +
                                  `建议操作:\n` +
                                  `1. 如果是交互式程序(vim/nano等), 请先正常退出\n` +
                                  `2. 如果是后台任务, 可以:\n` +
                                  `   - 等待任务完成（执行 sleep <seconds> 命令进行等待）\n` +
                                  `   - 使用 Ctrl+C (tmux send-keys -t ${sessionName} C-c)\n` +
                                  `   - 使用 kill -TERM ${panePid} 终止进程\n\n` +
                                  `为避免命令冲突, 本次操作已取消。如果确定要强制执行,请添加 force: true 参数。`
                          }],
                          isError: true
                        };
                      }
                    }
                  }
                } catch (error) {
                  console.error('检查tmux会话状态时出错:', error);
                }
              }
            }
          }
          
          // 检查是否是tmux命令
          const isTmuxSendKeys = tmuxSendKeysRegex.test(command);
          const isTmuxCapture = tmuxCaptureRegex.test(command);
          const isTmuxNewSession = tmuxNewSessionRegex.test(command);
          const isTmuxKillSession = tmuxKillSessionRegex.test(command);
          const isTmuxHasSession = tmuxHasSessionRegex.test(command);
          const isTmuxCommand = isTmuxSendKeys || isTmuxCapture || isTmuxNewSession || isTmuxKillSession || isTmuxHasSession;
          
          // 执行命令
          const result = await this.sshService.executeCommand(connectionId, command, { cwd, timeout });
          
          // 构建输出
          let output = '';
          
          // 构建命令提示符
          const currentDir = connection.currentDirectory || '~';
          const promptPrefix = `[${connection.config.username}@${connection.config.host}`;
          
          if (result.stdout) {
            output += result.stdout;
          }
          
          if (result.stderr) {
            if (output) output += '\n';
            output += `错误输出:\n${result.stderr}`;
          }
          
          if (result.code !== 0) {
            output += `\n命令退出码: ${result.code}`;
          }
          
          // 在输出末尾添加当前目录提示
          if (output) output += '\n';
          output += `\n${promptPrefix} ${currentDir}]$ `;
          
          // 如果是tmux命令且命令执行成功，增强输出信息
          if (isTmuxCommand && result.code === 0 && (!output || output.trim() === '')) {
            try {
              // 识别命令类型并处理
              
              // 对于 send-keys 命令
              if (isTmuxSendKeys && sessionName && beforeCapture?.stdout) {
                // 等待一段时间让命令执行完成
                await new Promise(resolve => setTimeout(resolve, 300));
                
                // 捕获tmux会话的当前内容
                const afterCapture = await this.sshService.executeCommand(
                  connectionId,
                  `tmux capture-pane -p -t ${sessionName}`,
                  { cwd, timeout: 5000 }
                );

                if (afterCapture?.stdout && beforeCapture?.stdout) {
                  // 比较前后差异，提取新增内容
                  const beforeLines = beforeCapture.stdout.trim().split('\n');
                  const afterLines = afterCapture.stdout.trim().split('\n');
                  
                  // 计算出内容差异
                  let diffOutput = '';
                  
                  // 计算共同前缀的行数
                  let commonPrefix = 0;
                  
                  // 方法1: 从后往前找到第一个不同的行
                  if (beforeLines.length > 0 && afterLines.length > 0) {
                    // 找到共同前缀的行数
                    while (commonPrefix < Math.min(beforeLines.length, afterLines.length) && 
                           beforeLines[commonPrefix] === afterLines[commonPrefix]) {
                      commonPrefix++;
                    }
                    
                    // 提取新增的行
                    const newLines = afterLines.slice(commonPrefix);
                    
                    if (newLines.length > 0) {
                      diffOutput = newLines.join('\n');
                    }
                    
                    // 如果提取失败或没有差异，尝试方法2
                    if (!diffOutput) {
                      // 方法2: 简单比较前后文本长度，如果变长了，取增加的部分
                      if (afterCapture.stdout.length > beforeCapture.stdout.length) {
                        const commonStart = beforeCapture.stdout.length;
                        // 提取增加的内容
                        diffOutput = afterCapture.stdout.substring(commonStart);
                      }
                    }
                  }
                  
                  // 如果有差异输出，使用它，但添加更多上下文
                  if (diffOutput && diffOutput.trim()) {
                    // 获取更多上下文：找到差异开始的位置
                    let contextOutput = '';
                    
                    // 向上找2-3个命令提示符标记（通常是$或#）来提供上下文
                    const promptRegex = /^.*[\$#>]\s+/m;
                    let promptCount = 0;
                    let contextLines = [];
                    
                    // 先从原始输出的中间部分向上搜索
                    const midPoint = Math.max(0, commonPrefix - 15);
                    for (let i = midPoint; i < afterLines.length; i++) {
                      contextLines.push(afterLines[i]);
                      // 如果遇到命令提示符，计数加1
                      if (promptRegex.test(afterLines[i])) {
                        promptCount++;
                      }
                      
                      // 如果已经找到2个命令提示符或者已经达到差异部分，停止
                      if (promptCount >= 2 || i >= commonPrefix) {
                        break;
                      }
                    }
                    
                    // 然后添加差异部分
                    contextOutput = contextLines.join('\n');
                    if (contextOutput && !contextOutput.endsWith('\n')) {
                      contextOutput += '\n';
                    }
                    
                    // 添加差异输出
                    contextOutput += diffOutput.trim();
                    
                    output = `命令已发送到tmux会话 "${sessionName}"，带上下文的输出:\n\n${contextOutput}`;
                  } 
                  // 如果没找到差异但内容确实变了，显示会话最后部分内容（带上下文）
                  else if (beforeCapture.stdout !== afterCapture.stdout) {
                    // 尝试获取最后几次命令和输出
                    const lastLines = afterLines.slice(-30).join('\n');
                    
                    // 寻找命令提示符，提取最后几个命令
                    const promptPositions = [];
                    const promptRegex = /^.*[\$#>]\s+/m;
                    
                    // 找出所有命令提示符的位置
                    for (let i = Math.max(0, afterLines.length - 30); i < afterLines.length; i++) {
                      if (promptRegex.test(afterLines[i])) {
                        promptPositions.push(i);
                      }
                    }
                    
                    // 如果找到了至少一个命令提示符
                    if (promptPositions.length > 0) {
                      // 取最后3个命令（如果有的话）
                      const startPosition = promptPositions.length > 3 
                        ? promptPositions[promptPositions.length - 3] 
                        : promptPositions[0];
                      
                      const contextOutput = afterLines.slice(startPosition).join('\n');
                      output = `命令已发送到tmux会话 "${sessionName}"，最近的命令和输出:\n\n${contextOutput}`;
                    } else {
                      // 如果没找到命令提示符，就使用最后20行
                      output = `命令已发送到tmux会话 "${sessionName}"，最近内容:\n\n${lastLines}`;
                    }
                  }
                  // 没有明显变化
                  else {
                    output = `命令已发送到tmux会话 "${sessionName}"，但未检测到输出变化`;
                  }
                }
              }
              // 对于 new-session 命令
              else if (isTmuxNewSession) {
                const match = command.match(tmuxNewSessionRegex);
                if (match) {
                  const sessionName = match[1];
                  output = `已创建新的tmux会话 "${sessionName}"`;
                  
                  // 检查会话是否真的创建成功
                  const checkResult = await this.sshService.executeCommand(
                    connectionId,
                    `tmux has-session -t ${sessionName} 2>/dev/null && echo "会话存在" || echo "会话创建失败"`,
                    { timeout: 3000 }
                  );
                  
                  if (checkResult.stdout && checkResult.stdout.includes("会话存在")) {
                    output += `\n会话已成功启动并在后台运行`;
                  }
                }
              }
              // 对于 kill-session 命令
              else if (isTmuxKillSession) {
                const match = command.match(tmuxKillSessionRegex);
                if (match) {
                  const sessionName = match[1];
                  output = `已终止tmux会话 "${sessionName}"`;
                }
              }
              // 对于 has-session 命令
              else if (isTmuxHasSession) {
                const match = command.match(tmuxHasSessionRegex);
                if (match) {
                  const sessionName = match[1];
                  if (result.code === 0) {
                    output = `tmux会话 "${sessionName}" 存在`;
                  } else {
                    output = `tmux会话 "${sessionName}" 不存在`;
                  }
                }
              }
              // 对于 capture-pane 命令
              else if (isTmuxCapture) {
                // 如果直接是capture-pane命令，输出就是其结果，不需要特殊处理
                if (!output || output.trim() === '') {
                  const match = command.match(tmuxCaptureRegex);
                  if (match) {
                    const sessionName = match[1];
                    output = `tmux会话 "${sessionName}" 内容已捕获，但原始命令未返回输出内容`;
                  }
                }
              }
              // 对于复合命令（含有多个tmux命令）
              else if (command.includes("tmux") && (command.includes("&&") || command.includes(";"))) {
                // 尝试提取最后一个tmux命令的会话名
                const tmuxCommands = command.split(/&&|;/).map(cmd => cmd.trim());
                let lastSessionName = null;
                
                for (const cmd of tmuxCommands) {
                  let match;
                  if ((match = cmd.match(tmuxNewSessionRegex)) ||
                      (match = cmd.match(tmuxKillSessionRegex)) ||
                      (match = cmd.match(tmuxHasSessionRegex)) ||
                      (match = cmd.match(tmuxSendKeysRegex)) ||
                      (match = cmd.match(tmuxCaptureRegex))) {
                    lastSessionName = match[1];
                  }
                }
                
                if (lastSessionName) {
                  // 如果最后一个命令是创建会话，通知用户会话已创建
                  if (tmuxCommands[tmuxCommands.length-1].includes("new-session")) {
                    output = `已执行tmux复合命令，最后创建了会话 "${lastSessionName}"`;
                    
                    // 等待会话创建完成
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    // 检查会话是否真的创建成功
                    const checkResult = await this.sshService.executeCommand(
                      connectionId,
                      `tmux has-session -t ${lastSessionName} 2>/dev/null && echo "会话存在" || echo "会话创建失败"`,
                      { timeout: 3000 }
                    );
                    
                    if (checkResult.stdout && checkResult.stdout.includes("会话存在")) {
                      output += `\n会话已成功启动并在后台运行`;
                    }
                  }
                  // 如果最后一个命令是kill-session，通知用户会话已终止
                  else if (tmuxCommands[tmuxCommands.length-1].includes("kill-session")) {
                    output = `已执行tmux复合命令，最后终止了会话 "${lastSessionName}"`;
                  }
                  // 对于其他复合命令，尝试捕获最后一个会话的内容
                  else {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    // 等待会话阻塞状态解除或超时（最多等待10分钟）
                    let isBlocked = true;
                    let waitStartTime = Date.now();
                    const maxWaitTime = 10 * 60 * 1000; // 10分钟
                    
                    while (isBlocked && (Date.now() - waitStartTime < maxWaitTime)) {
                      try {
                        // 检查会话是否处于阻塞状态
                        const checkResult = await this.sshService.executeCommand(
                          connectionId,
                          `tmux list-panes -t ${lastSessionName} -F "#{pane_pid} #{pane_current_command}"`,
                          { cwd, timeout: 5000 }
                        );
                        
                        if (checkResult?.stdout) {
                          const [panePid, currentCommand] = checkResult.stdout.trim().split(' ');

                          // 同上：只接受纯数字的 pid
                          if (panePid && /^\d+$/.test(panePid)) {
                            // 获取进程状态
                            const processResult = await this.sshService.executeCommand(
                              connectionId,
                              `ps -o state= -p ${panePid}`,
                              { timeout: 3000 }
                            );
                            
                            const processState = processResult?.stdout?.trim();
                            
                            // 检查是否处于阻塞状态
                            isBlocked = 
                              // 进程状态检查
                              processState === 'D' || // 不可中断的睡眠状态
                              processState === 'T' || // 已停止
                              processState === 'W' || // 分页等待
                              
                              // 常见的交互式程序
                              /^(vim|nano|less|more|top|htop|man)$/.test(currentCommand) ||
                              
                              // 检查是否有子进程在运行
                              ((await this.sshService.executeCommand(
                                connectionId,
                                `pgrep -P ${panePid}`,
                                { timeout: 3000 }
                              ))?.stdout || '').trim() !== '';
                            
                            if (!isBlocked) {
                              // 阻塞已解除，退出循环
                              break;
                            }
                            
                            // 等待一段时间再检查
                            await new Promise(resolve => setTimeout(resolve, 5000));
                          } else {
                            // 没有有效的进程ID，认为没有阻塞
                            isBlocked = false;
                          }
                        } else {
                          // 无法获取会话信息，认为没有阻塞
                          isBlocked = false;
                        }
                      } catch (error) {
                        console.error('检查会话阻塞状态时出错:', error);
                        // 出错时认为没有阻塞，避免无限循环
                        isBlocked = false;
                      }
                    }
                    
                    // 检查是否是因为超时而退出循环
                    if (isBlocked && (Date.now() - waitStartTime >= maxWaitTime)) {
                      // 获取当前状态信息
                      try {
                        const processInfo = await this.sshService.executeCommand(
                          connectionId,
                          `tmux list-panes -t ${lastSessionName} -F "#{pane_pid}" | xargs ps -o pid,ppid,stat,time,command -p`,
                          { timeout: 5000 }
                        );
                        
                        const contextOutput = await this.sshService.executeCommand(
                          connectionId,
                          `tmux capture-pane -p -t ${lastSessionName} -S -10`,
                          { timeout: 3000 }
                        );
                        
                        output = `已执行tmux复合命令，但会话 "${lastSessionName}" 仍处于阻塞状态超过10分钟:\n\n` +
                                `当前会话上下文:\n${contextOutput.stdout}\n\n` +
                                `进程信息:\n${processInfo.stdout}\n\n` +
                                `如果是正常情况，请执行 sleep <seconds> 命令等待`;
                      } catch (error) {
                        output = `已执行tmux复合命令，但会话 "${lastSessionName}" 仍处于阻塞状态超过10分钟。无法获取详细信息。`;
                      }
                    } else {
                      // 阻塞已解除或会话不存在，获取会话内容
                      try {
                        const captureResult = await this.sshService.executeCommand(
                          connectionId,
                          `tmux has-session -t ${lastSessionName} 2>/dev/null && tmux capture-pane -p -t ${lastSessionName} || echo "会话不存在"`,
                          { cwd, timeout: 5000 }
                        );
                        
                        if (captureResult.stdout && !captureResult.stdout.includes("会话不存在")) {
                          // 提取最后40行
                          const lines = captureResult.stdout.split('\n');
                          const lastLines = lines.slice(-40).join('\n');
                          
                          output = `已执行tmux复合命令，会话 "${lastSessionName}" 当前内容:\n\n${lastLines}`;
                        } else {
                          output = `已执行tmux复合命令，但会话 "${lastSessionName}" 不存在或无法捕获内容`;
                        }
                      } catch (err) {
                        output = `已执行tmux复合命令，涉及会话 "${lastSessionName}"`;
                      }
                    }
                  }
                } else {
                  output = "已执行tmux复合命令";
                }
              }
            } catch (captureError) {
              console.error('处理tmux命令输出时出错:', captureError);
              // 如果捕获失败，使用原始输出
              output = `tmux命令已执行，但无法获取额外信息: ${captureError instanceof Error ? captureError.message : String(captureError)}`;
            }
          }
          
          // 处理输出长度限制
          output = this.limitOutputLength(output);
          
          return {
            content: [{
              type: "text",
              text: output || '命令执行成功，无输出'
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `执行命令时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 后台执行命令
    this.server.tool(
      "backgroundExecute",
      "Executes a command in the background on a remote server at a specified interval.",
      {
        connectionId: z.string(),
        command: z.string(),
        interval: z.number().optional(),
        cwd: z.string().optional()
      },
      async ({ connectionId, command, interval = 10000, cwd }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 如果已存在后台任务，先停止
          if (this.backgroundExecutions.has(connectionId)) {
            this.stopBackgroundExecution(connectionId);
          }
          
          // 更新活跃时间
          this.activeConnections.set(connectionId, new Date());
          
          // 先执行一次命令
          await this.sshService.executeCommand(connectionId, command, { cwd });
          
          // 设置定时器
          const timer = setInterval(async () => {
            try {
              const conn = this.sshService.getConnection(connectionId);
              if (conn && conn.status === ConnectionStatus.CONNECTED) {
                await this.sshService.executeCommand(connectionId, command, { cwd });
                
                // 更新最后检查时间
                const bgExec = this.backgroundExecutions.get(connectionId);
                if (bgExec) {
                  bgExec.lastCheck = new Date();
                }
              } else {
                // 如果连接已不可用，停止后台任务
                this.stopBackgroundExecution(connectionId);
              }
            } catch (error) {
              console.error(`后台执行命令出错:`, error);
              // 不停止任务，继续下一次尝试
            }
          }, interval);
          
          // 记录后台任务
          this.backgroundExecutions.set(connectionId, {
            interval: timer,
            lastCheck: new Date()
          });
          
          return {
            content: [{
              type: "text",
              text: `已在后台启动命令: ${command}\n间隔: ${interval / 1000}秒\n连接: ${connection.name || connectionId}\n\n使用 stopBackground 工具可停止此后台任务。`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `设置后台任务时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 停止后台执行
    this.server.tool(
      "stopBackground",
      "Stops a background command execution on a specific connection.",
      {
        connectionId: z.string()
      },
      ({ connectionId }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (!this.backgroundExecutions.has(connectionId)) {
            return {
              content: [{
                type: "text",
                text: `连接 ${connection.name || connectionId} 没有正在运行的后台任务`
              }]
            };
          }
          
          // 停止后台任务
          this.stopBackgroundExecution(connectionId);
          
          return {
            content: [{
              type: "text",
              text: `已停止连接 ${connection.name || connectionId} 的后台任务`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `停止后台任务时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 获取当前目录工具
    this.server.tool(
      "getCurrentDirectory",
      "Gets the current working directory of an SSH connection.",
      {
        connectionId: z.string()
      },
      async ({ connectionId }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 更新活跃时间
          this.activeConnections.set(connectionId, new Date());
          
          // 获取当前目录
          const result = await this.sshService.executeCommand(connectionId, 'pwd');
          
          return {
            content: [{
              type: "text",
              text: result.stdout.trim()
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取当前目录时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  }
  
  /**
   * 注册文件传输工具
   */
  private registerFileTools(): void {
    // 上传文件
    this.server.tool(
      "uploadFile",
      "Uploads a local file to a remote server.",
      {
        connectionId: z.string(),
        localPath: z.string(),
        remotePath: z.string()
      },
      async ({ connectionId, localPath, remotePath }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 检查本地文件是否存在
          if (!fs.existsSync(localPath)) {
            return {
              content: [{
                type: "text",
                text: `错误: 本地文件 "${localPath}" 不存在`
              }],
              isError: true
            };
          }
          
          // 更新活跃时间
          this.activeConnections.set(connectionId, new Date());
          
          // 上传文件并获取传输ID
          const transferInfo = await this.sshService.uploadFile(connectionId, localPath, remotePath);
          const transferId = transferInfo.id;

          // 这里原本订阅 onTransferProgress 只为调用 server.sendEvent 推送进度，
          // 但 MCP SDK 上并不存在 sendEvent（被 `as any` 掩盖），每次回调都抛
          // TypeError 并被 index.ts 的 uncaughtException 吞掉。
          // 且 server 主动推送的通知不会进入模型上下文，推了也没人读。
          // uploadFile 本身是 await 的，返回即已完成，进度订阅没有意义；
          // 需要查询进度的场景走 getFileTransferStatus 工具。
          const result = this.sshService.getTransferInfo(transferId);

          if (result && result.status === 'failed') {
            return {
              content: [{
                type: "text",
                text: `文件上传失败: ${result.error || '未知错误'}`
              }],
              isError: true,
              transferId
            };
          }

          const fileName = path.basename(localPath);

          return {
            content: [{
              type: "text",
              text: `文件 "${fileName}" 上传成功\n本地路径: ${localPath}\n远程路径: ${remotePath}`
            }],
            transferId
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `上传文件时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 下载文件
    this.server.tool(
      "downloadFile",
      "Downloads a file from a remote server to the local machine.",
      {
        connectionId: z.string(),
        remotePath: z.string(),
        localPath: z.string().optional()
      },
      async ({ connectionId, remotePath, localPath }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 确定本地保存路径
          let savePath = localPath;
          if (!savePath) {
            const fileName = path.basename(remotePath);
            savePath = path.join(os.homedir(), 'Downloads', fileName);
            
            // 确保目录存在
            const saveDir = path.dirname(savePath);
            if (!fs.existsSync(saveDir)) {
              fs.mkdirSync(saveDir, { recursive: true });
            }
          }
          
          // 更新活跃时间
          this.activeConnections.set(connectionId, new Date());
          
          // 下载文件并获取传输ID
          const transferInfo = await this.sshService.downloadFile(connectionId, remotePath, savePath);
          const transferId = transferInfo.id;

          // 同 uploadFile：移除基于 sendEvent 的进度订阅（该方法在 SDK 中不存在）。
          // downloadFile 已 await，返回即完成；进度查询走 getFileTransferStatus。
          const result = this.sshService.getTransferInfo(transferId);

          if (result && result.status === 'failed') {
            return {
              content: [{
                type: "text",
                text: `文件下载失败: ${result.error || '未知错误'}`
              }],
              isError: true,
              transferId
            };
          }

          const fileName = path.basename(remotePath);

          return {
            content: [{
              type: "text",
              text: `文件 "${fileName}" 下载成功\n远程路径: ${remotePath}\n本地路径: ${savePath}`
            }],
            transferId
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `下载文件时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 批量上传文件
    this.server.tool(
      "batchUploadFiles",
      "Uploads multiple local files to a remote server.",
      {
        connectionId: z.string(),
        files: z.array(z.object({
          localPath: z.string(),
          remotePath: z.string()
        }))
      },
      async ({ connectionId, files }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 检查所有本地文件是否存在
          const missingFiles = files.filter(file => !fs.existsSync(file.localPath));
          if (missingFiles.length > 0) {
            return {
              content: [{
                type: "text",
                text: `错误: 以下本地文件不存在:\n${missingFiles.map(f => f.localPath).join('\n')}`
              }],
              isError: true
            };
          }
          
          // 更新活跃时间
          this.activeConnections.set(connectionId, new Date());
          
          // 批量传输文件
          const transferIds = await this.sshService.batchTransfer({
            connectionId,
            items: files,
            direction: 'upload'
          });
          
          if (transferIds.length === 0) {
            return {
              content: [{
                type: "text",
                text: `没有文件被上传`
              }],
              isError: true
            };
          }
          
          // 获取传输信息
          const transferInfos = transferIds.map(id => this.sshService.getTransferInfo(id)).filter(Boolean) as FileTransferInfo[];

          // 移除基于 sendEvent 的进度订阅（该方法在 SDK 中不存在，每次回调都抛异常）。
          // 单个文件的进度可通过 getFileTransferStatus 查询。
          await this.waitForTransfers(transferIds);

          // 计算成功和失败的数量
          const successCount = transferInfos.filter(info => info.status === 'completed').length;
          const failedCount = transferInfos.filter(info => info.status === 'failed').length;

          return {
            content: [{
              type: "text",
              text: `批量上传完成\n成功: ${successCount}个文件\n失败: ${failedCount}个文件`
            }],
            transferIds
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `批量上传文件时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 批量下载文件
    this.server.tool(
      "batchDownloadFiles",
      "Downloads multiple files from a remote server.",
      {
        connectionId: z.string(),
        files: z.array(z.object({
          remotePath: z.string(),
          localPath: z.string().optional()
        }))
      },
      async ({ connectionId, files }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 处理本地路径
          const normalizedFiles = files.map(file => {
            if (!file.remotePath) {
              return null; // 跳过无效项
            }
            
            // 如果没有提供本地路径，生成一个默认路径
            if (!file.localPath) {
              const fileName = path.basename(file.remotePath);
              const localPath = path.join(os.homedir(), 'Downloads', fileName);
              
              // 确保目录存在
              const saveDir = path.dirname(localPath);
              if (!fs.existsSync(saveDir)) {
                fs.mkdirSync(saveDir, { recursive: true });
              }
              
              return { remotePath: file.remotePath, localPath };
            }
            return file;
          }).filter(item => item !== null) as { remotePath: string, localPath: string }[];
          
          if (normalizedFiles.length === 0) {
            return {
              content: [{
                type: "text",
                text: `错误: 没有有效的文件传输项`
              }],
              isError: true
            };
          }
          
          // 更新活跃时间
          this.activeConnections.set(connectionId, new Date());
          
          // 开始批量下载
          const transferIds = await this.sshService.batchTransfer({
            connectionId,
            items: normalizedFiles,
            direction: 'download'
          });
          
          if (transferIds.length === 0) {
            return {
              content: [{
                type: "text",
                text: `没有文件被下载`
              }],
              isError: true
            };
          }
          
          // 获取传输信息
          const transferInfos = transferIds.map(id => this.sshService.getTransferInfo(id)).filter(Boolean) as FileTransferInfo[];

          // 移除基于 sendEvent 的进度订阅（该方法在 SDK 中不存在，每次回调都抛异常）。
          // 单个文件的进度可通过 getFileTransferStatus 查询。
          await this.waitForTransfers(transferIds);

          // 计算成功和失败的数量
          const successCount = transferInfos.filter(info => info.status === 'completed').length;
          const failedCount = transferInfos.filter(info => info.status === 'failed').length;

          return {
            content: [{
              type: "text",
              text: `批量下载完成\n成功: ${successCount}个文件\n失败: ${failedCount}个文件`
            }],
            transferIds
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `批量下载文件时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 获取文件传输状态
    this.server.tool(
      "getFileTransferStatus",
      "Gets the status of a specific file transfer.",
      {
        transferId: z.string()
      },
      async ({ transferId }) => {
        try {
          const transfer = this.sshService.getTransferInfo(transferId);
          
          if (!transfer) {
            return {
              content: [{
                type: "text",
                text: `错误: 传输 ${transferId} 不存在`
              }],
              isError: true
            };
          }
          
          let statusText;
          switch (transfer.status) {
            case 'pending':
              statusText = '等待中';
              break;
            case 'in-progress':
              statusText = '传输中';
              break;
            case 'completed':
              statusText = '已完成';
              break;
            case 'failed':
              statusText = '失败';
              break;
            default:
              statusText = transfer.status;
          }
          
          const directionText = transfer.direction === 'upload' ? '上传' : '下载';
          const fileName = transfer.direction === 'upload' 
            ? path.basename(transfer.localPath)
            : path.basename(transfer.remotePath);
          
          let output = `文件 ${directionText} 状态:\n`;
          output += `ID: ${transfer.id}\n`;
          output += `文件名: ${fileName}\n`;
          output += `状态: ${statusText}\n`;
          output += `进度: ${Math.round(transfer.progress)}%\n`;
          output += `大小: ${this.formatFileSize(transfer.size)}\n`;
          output += `已传输: ${this.formatFileSize(transfer.bytesTransferred)}\n`;
          
          if (transfer.startTime) {
            output += `开始时间: ${transfer.startTime.toLocaleString()}\n`;
          }
          
          if (transfer.endTime) {
            output += `结束时间: ${transfer.endTime.toLocaleString()}\n`;
            
            // 计算传输速度
            const duration = (transfer.endTime.getTime() - transfer.startTime.getTime()) / 1000;
            if (duration > 0) {
              const speed = transfer.bytesTransferred / duration;
              output += `平均速度: ${this.formatFileSize(speed)}/s\n`;
            }
          }
          
          if (transfer.error) {
            output += `错误: ${transfer.error}\n`;
          }
          
          return {
            content: [{
              type: "text",
              text: output
            }],
            transfer
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取文件传输状态时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 列出所有文件传输
    this.server.tool(
      "listFileTransfers",
      "Lists all recent file transfers.",
      {},
      async () => {
        try {
          const transfers = this.sshService.getAllTransfers();
          
          if (transfers.length === 0) {
            return {
              content: [{
                type: "text",
                text: "没有文件传输记录"
              }]
            };
          }
          
          let output = `文件传输记录 (${transfers.length}):\n\n`;
          
          for (const transfer of transfers) {
            const fileName = transfer.direction === 'upload' 
              ? path.basename(transfer.localPath)
              : path.basename(transfer.remotePath);
            
            let status;
            switch (transfer.status) {
              case 'pending':
                status = '⏳ 等待中';
                break;
              case 'in-progress':
                status = '🔄 传输中';
                break;
              case 'completed':
                status = '✅ 已完成';
                break;
              case 'failed':
                status = '❌ 失败';
                break;
              default:
                status = transfer.status;
            }
            
            output += `${status} ${transfer.direction === 'upload' ? '⬆️' : '⬇️'} ${fileName}\n`;
            output += `ID: ${transfer.id}\n`;
            output += `进度: ${Math.round(transfer.progress)}% (${this.formatFileSize(transfer.bytesTransferred)}/${this.formatFileSize(transfer.size)})\n`;
            
            if (transfer.startTime) {
              output += `开始: ${transfer.startTime.toLocaleString()}\n`;
            }
            
            if (transfer.endTime) {
              output += `结束: ${transfer.endTime.toLocaleString()}\n`;
            }
            
            if (transfer.error) {
              output += `错误: ${transfer.error}\n`;
            }
            
            output += '\n';
          }
          
          return {
            content: [{
              type: "text",
              text: output
            }],
            transfers
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取文件传输列表时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  }
  
  /**
   * 注册会话管理工具
   */
  private registerSessionTools(): void {
    // 列出活跃会话
    this.server.tool(
      "listActiveSessions",
      "Lists all currently active SSH sessions.",
      {},
      async () => {
        try {
          if (this.activeConnections.size === 0) {
            return {
              content: [{
                type: "text",
                text: "当前没有活跃的会话"
              }]
            };
          }
          
          let output = "活跃会话:\n\n";
          
          for (const [id, lastActive] of this.activeConnections.entries()) {
            const connection = this.sshService.getConnection(id);
            if (connection) {
              output += this.formatConnectionInfo(connection);
              output += `上次活动: ${this.formatTimeDifference(lastActive)}\n`;
              
              if (this.backgroundExecutions.has(id)) {
                const bgExec = this.backgroundExecutions.get(id);
                if (bgExec) {
                  output += `后台任务: 活跃中，最后执行: ${this.formatTimeDifference(bgExec.lastCheck)}\n`;
                }
              }
              
              output += "\n---\n\n";
            }
          }
          
          return {
            content: [{
              type: "text",
              text: output
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取活跃会话时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 列出后台任务
    this.server.tool(
      "listBackgroundTasks",
      "Lists all background tasks currently running.",
      {},
      () => {
        try {
          if (this.backgroundExecutions.size === 0) {
            return {
              content: [{
                type: "text",
                text: "当前没有运行中的后台任务"
              }]
            };
          }
          
          let output = "运行中的后台任务:\n\n";
          
          for (const [id, info] of this.backgroundExecutions.entries()) {
            const connection = this.sshService.getConnection(id);
            if (connection) {
              output += `连接: ${connection.name || connection.id}\n`;
              output += `主机: ${connection.config.host}\n`;
              output += `用户: ${connection.config.username}\n`;
              output += `状态: ${connection.status}\n`;
              output += `最后执行: ${this.formatTimeDifference(info.lastCheck)}\n`;
              output += "\n---\n\n";
            }
          }
          
          return {
            content: [{
              type: "text",
              text: output
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取后台任务时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 停止所有后台任务
    this.server.tool(
      "stopAllBackgroundTasks",
      "Stops all running background tasks.",
      {},
      () => {
        try {
          const count = this.backgroundExecutions.size;
          
          if (count === 0) {
            return {
              content: [{
                type: "text",
                text: "当前没有运行中的后台任务"
              }]
            };
          }
          
          // 停止所有后台任务
          for (const id of this.backgroundExecutions.keys()) {
            this.stopBackgroundExecution(id);
          }
          
          return {
            content: [{
              type: "text",
              text: `已停止所有 ${count} 个后台任务`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `停止所有后台任务时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  }
  
  /**
   * 注册终端交互工具
   */
  private registerTerminalTools() {
    // 创建终端会话
    this.server.tool(
      "mcp_ssh_mcp_createTerminalSession",
      "Creates a new interactive terminal session.",
      {
        connectionId: z.string(),
        rows: z.number().optional(),
        cols: z.number().optional(),
        term: z.string().optional(),
      },
      async (params) => {
        try {
          const { connectionId, rows, cols, term } = params;
          const sessionId = await this.sshService.createTerminalSession(connectionId, { rows, cols, term });

          // 等待 shell 打出第一个提示符，让调用方一开始就看到终端状态，
          // 不必先盲写一次再读。
          const initial = await this.sshService.readTerminalStable(sessionId, {
            timeout: 3000,
            quietMs: 300
          });

          let text = `已创建终端会话 ${sessionId}\n`;
          text += `游标: ${initial.cursor}（下次 readTerminal 传 since=${initial.cursor} 可只取新增内容）\n`;
          if (initial.data) {
            text += `\n当前终端内容:\n${this.limitOutputLength(initial.data)}`;
          }

          return {
            content: [{
              type: "text",
              text
            }],
            sessionId,
            cursor: initial.cursor
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`创建终端会话失败:`, error);
          return {
            content: [{
              type: "text",
              text: `创建终端会话失败: ${errorMessage}`
            }],
            isError: true
          };
        }
      }
    );

    // 读取终端输出
    this.server.tool(
      "mcp_ssh_mcp_readTerminal",
      "Reads output from an interactive terminal session. Pass the cursor from a previous call to read only new data.",
      {
        sessionId: z.string(),
        since: z.number().optional(),
        timeout: z.number().optional(),
        waitForOutput: z.boolean().optional().default(true)
      },
      async ({ sessionId, since, timeout, waitForOutput }) => {
        try {
          const result = waitForOutput
            ? await this.sshService.readTerminalStable(sessionId, { since, timeout })
            : { ...this.sshService.readTerminal(sessionId, since), timedOut: false };

          let text = '';

          if (result.droppedBytes > 0) {
            text += `注意: 缓冲区上限导致最早的 ${result.droppedBytes} 字节已被丢弃\n`;
          }

          if (!result.isActive) {
            text += `会话已结束`;
            if (typeof result.exitCode === 'number') {
              text += `（退出码 ${result.exitCode}）`;
            }
            text += '\n';
          } else if (result.timedOut) {
            text += `等待超时，终端仍有输出或处于阻塞状态（返回目前已收到的内容）\n`;
          }

          if (text) text += '\n';

          text += result.data
            ? this.limitOutputLength(result.data)
            : '（无新输出）';

          text += `\n\n游标: ${result.cursor}`;

          return {
            content: [{
              type: "text",
              text
            }],
            cursor: result.cursor,
            isActive: result.isActive
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `读取终端输出时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 向终端写入数据
    this.server.tool(
      "mcp_ssh_mcp_writeToTerminal",
      "Writes data to an interactive terminal session and returns the resulting output.",
      {
        sessionId: z.string(),
        data: z.string(),
        timeout: z.number().optional(),
        waitForOutput: z.boolean().optional().default(true)
      },
      async (params) => {
        try {
          const { sessionId, data, timeout, waitForOutput } = params;

          // 先记下当前游标，写入后只读回本次产生的新输出
          const before = this.sshService.readTerminal(sessionId);
          const success = await this.sshService.writeToTerminal(sessionId, data);

          if (!success) {
            return {
              content: [{
                type: "text",
                text: `数据发送失败: 会话 ${sessionId} 不存在或已关闭`
              }],
              isError: true
            };
          }

          if (!waitForOutput) {
            return {
              content: [{
                type: "text",
                text: `数据已发送到终端 ${sessionId}`
              }],
              success: true,
              cursor: before.cursor
            };
          }

          // 写入后等待终端响应稳定，把回显直接带回去，
          // 免去调用方再单独发一次 readTerminal。
          const result = await this.sshService.readTerminalStable(sessionId, {
            since: before.cursor,
            timeout
          });

          let text = '';
          if (!result.isActive) {
            text += `会话已结束`;
            if (typeof result.exitCode === 'number') {
              text += `（退出码 ${result.exitCode}）`;
            }
            text += '\n\n';
          } else if (result.timedOut) {
            text += `等待超时，终端可能仍在输出或等待输入（返回目前已收到的内容）\n\n`;
          }

          text += result.data
            ? this.limitOutputLength(result.data)
            : '（无输出）';
          text += `\n\n游标: ${result.cursor}`;

          return {
            content: [{
              type: "text",
              text
            }],
            success: true,
            cursor: result.cursor,
            isActive: result.isActive
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `向终端写入数据时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );

    // 关闭终端会话
    this.server.tool(
      "mcp_ssh_mcp_closeTerminalSession",
      "Closes an interactive terminal session and releases its resources.",
      {
        sessionId: z.string()
      },
      async ({ sessionId }) => {
        try {
          const success = await this.sshService.closeTerminalSession(sessionId);
          return {
            content: [{
              type: "text",
              text: success
                ? `终端会话 ${sessionId} 已关闭`
                : `终端会话 ${sessionId} 不存在或已关闭`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `关闭终端会话时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  }

  /**
   * 注册隧道管理工具
   */
  private registerTunnelTools(): void {
    // 创建隧道
    this.server.tool(
      "createTunnel",
      "Creates an SSH tunnel (port forwarding).",
      {
        connectionId: z.string(),
        localPort: z.number(),
        remoteHost: z.string(),
        remotePort: z.number(),
        description: z.string().optional()
      },
      async ({ connectionId, localPort, remoteHost, remotePort, description }) => {
        try {
          const connection = this.sshService.getConnection(connectionId);
          
          if (!connection) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connectionId} 不存在`
              }],
              isError: true
            };
          }
          
          if (connection.status !== ConnectionStatus.CONNECTED) {
            return {
              content: [{
                type: "text",
                text: `错误: 连接 ${connection.name || connectionId} 未连接`
              }],
              isError: true
            };
          }
          
          // 创建隧道
          const tunnelId = await this.sshService.createTunnel({
            connectionId,
            localPort,
            remoteHost,
            remotePort,
            description
          });
          
          return {
            content: [{
              type: "text",
              text: `隧道已创建\n本地端口: ${localPort}\n远程: ${remoteHost}:${remotePort}\n隧道ID: ${tunnelId}`
            }],
            tunnelId
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `创建隧道时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 关闭隧道
    this.server.tool(
      "closeTunnel",
      "Closes an active SSH tunnel.",
      {
        tunnelId: z.string()
      },
      async ({ tunnelId }) => {
        try {
          const success = await this.sshService.closeTunnel(tunnelId);
          
          if (success) {
            return {
              content: [{
                type: "text",
                text: `隧道 ${tunnelId} 已关闭`
              }]
            };
          } else {
            return {
              content: [{
                type: "text",
                text: `关闭隧道 ${tunnelId} 失败`
              }],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `关闭隧道时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
    
    // 列出所有隧道
    this.server.tool(
      "listTunnels",
      "Lists all active SSH tunnels.",
      {},
      () => {
        try {
          const tunnels = this.sshService.getTunnels();
          
          if (tunnels.length === 0) {
            return {
              content: [{
                type: "text",
                text: "当前没有活跃的隧道"
              }]
            };
          }
          
          let output = "活跃的隧道:\n\n";
          
          for (const tunnel of tunnels) {
            const connection = this.sshService.getConnection(tunnel.connectionId);
            output += `ID: ${tunnel.id}\n`;
            output += `本地端口: ${tunnel.localPort}\n`;
            output += `远程: ${tunnel.remoteHost}:${tunnel.remotePort}\n`;
            
            if (connection) {
              output += `连接: ${connection.name || connection.id} (${connection.config.host})\n`;
            }
            
            if (tunnel.description) {
              output += `描述: ${tunnel.description}\n`;
            }
            
            output += "\n---\n\n";
          }
          
          return {
            content: [{
              type: "text",
              text: output
            }],
            tunnels
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `获取隧道列表时出错: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  }

  /**
   * 关闭所有连接并清理资源
   */
  public async close(): Promise<void> {
    try {
      // 停止所有后台任务
      for (const id of this.backgroundExecutions.keys()) {
        this.stopBackgroundExecution(id);
      }
      
      // 关闭所有隧道
      const tunnels = this.sshService.getTunnels();
      for (const tunnel of tunnels) {
        await this.sshService.closeTunnel(tunnel.id!);
      }

      // 关闭所有终端会话
      const sessions = this.sshService.getAllTerminalSessions();
      for (const session of sessions) {
        await this.sshService.closeTerminalSession(session.id);
      }
      
      // 断开所有连接
      const connections = await this.sshService.getAllConnections();
      for (const connection of connections) {
        if (connection.status === ConnectionStatus.CONNECTED) {
          await this.sshService.disconnect(connection.id);
        }
      }
      
      // 关闭SSH服务
      await this.sshService.close();
      
      // 清空活跃连接记录
      this.activeConnections.clear();
      this.backgroundExecutions.clear();
    } catch (error) {
      console.error('关闭SSH MCP时出错:', error);
      throw error;
    }
  }

  /**
   * 处理长文本输出，超过限制时截取前后部分
   */
  private limitOutputLength(text: string, maxLength: number = 10000, targetLength: number = 6000): string {
    if (text.length <= maxLength) {
      return text;
    }

    // 计算保留前后部分的长度
    const halfTargetLength = Math.floor(targetLength / 2);
    
    // 提取前后部分
    const prefix = text.substring(0, halfTargetLength);
    const suffix = text.substring(text.length - halfTargetLength);
    
    // 添加省略指示及如何获取完整输出的提示
    const omittedLength = text.length - targetLength;
    const omittedMessage = `\n\n... 已省略 ${omittedLength} 个字符 ...\n` +
                           `如需查看完整输出，可添加以下参数：\n` +
                           `- 使用 > output.txt 将输出保存到文件\n` +
                           `- 使用 | head -n 数字 查看前几行\n` +
                           `- 使用 | tail -n 数字 查看后几行\n` +
                           `- 使用 | grep "关键词" 过滤包含特定内容的行\n\n`;
    
    // 组合输出
    return prefix + omittedMessage + suffix;
  }
}
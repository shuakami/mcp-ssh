import { NodeSSH } from 'node-ssh';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import Loki, { Collection } from 'lokijs';
// import keytar from 'keytar'; // We will import this dynamically
import { EventEmitter } from 'events';
import * as net from 'net';
import { Client as SSHClient, ConnectConfig, SFTPWrapper } from 'ssh2';
import { SSHExecCommandResponse, SSHExecOptions } from 'node-ssh';

// 连接配置
export interface SSHConnectionConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  keepaliveInterval?: number;
  readyTimeout?: number;
  reconnect?: boolean;
  reconnectTries?: number;
  reconnectDelay?: number;
}

// 连接状态
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

// 连接详情
export interface SSHConnection {
  id: string;
  name?: string;
  config: SSHConnectionConfig;
  status: ConnectionStatus;
  lastUsed?: Date;
  lastError?: string;
  client?: NodeSSH;
  tags?: string[];
  currentDirectory?: string;
}

// 执行命令结果
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

// 后台任务结果
export interface BackgroundTaskResult {
  id: string;
  output: string;
  isRunning: boolean;
  exitCode?: number;
  error?: string;
  startTime: Date;
  endTime?: Date;
}

// 后台任务信息
interface BackgroundTask {
  client: NodeSSH;
  process: any; // SSHExecCommandResponse类型，但实际上可能包含附加属性
  output: string;
  isRunning: boolean;
  exitCode?: number;
  error?: string;
  startTime: Date;
  endTime?: Date;
  interval?: NodeJS.Timeout;
}

// SSH隧道配置
export interface TunnelConfig {
  id?: string;
  connectionId: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  description?: string;
}

// 文件传输信息
export interface FileTransferInfo {
  id: string;
  localPath: string;
  remotePath: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  progress: number;
  size: number;
  bytesTransferred: number;
  error?: string;
  startTime: Date;
  endTime?: Date;
}

// 批量传输配置
export interface BatchTransferConfig {
  connectionId: string;
  items: {
    localPath: string;
    remotePath: string;
  }[];
  direction: 'upload' | 'download';
}

// 终端会话配置
export interface TerminalSessionConfig {
  rows?: number;
  cols?: number;
  term?: string;
}

// 终端会话信息
export interface TerminalSession {
  id: string;
  connectionId: string;
  stream: any;
  rows: number;
  cols: number;
  term: string;
  isActive: boolean;
  startTime: Date;
  lastActivity: Date;
  sudoPasswordPrompt: boolean;
}

// 终端数据事件
export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

// 终端调整大小事件
export interface TerminalResizeEvent {
  sessionId: string;
  rows: number;
  cols: number;
}

// 服务类
export class SSHService {
  private connections: Map<string, SSHConnection> = new Map();
  private db: Loki | null = null;
  private connectionCollection: Collection<any> | null = null;
  private credentialCollection: Collection<any> | null = null;
  private dataPath: string;
  private serviceReady: boolean = false;
  private serviceReadyPromise: Promise<void>;
  private isDocker: boolean = false;
  
  // 后台任务管理
  private backgroundTasks: Map<string, BackgroundTask> = new Map();
  
  // SSH隧道管理
  private tunnels: Map<string, {
    config: TunnelConfig,
    server?: net.Server,
    connections: Set<net.Socket>,
    isActive: boolean
  }> = new Map();
  
  // 事件发射器
  private eventEmitter: EventEmitter = new EventEmitter();
  
  // 文件传输管理
  private fileTransfers: Map<string, FileTransferInfo> = new Map();
  
  // 终端会话管理
  private terminalSessions: Map<string, TerminalSession> = new Map();
  
  constructor() {
    this.dataPath = process.env.SSH_DATA_PATH || path.join(os.homedir(), '.mcp-ssh');
    this.isDocker = process.env.IS_DOCKER === 'true';
    
    // 创建数据目录（如果不存在）
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
    
    // 初始化数据库
    this.serviceReadyPromise = this.initDatabase();
    
    // 设置定期清理任务
    this.setupCleanupTasks();
  }
  
  private async initDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new Loki(path.join(this.dataPath, 'ssh-connections.db'), {
        autoload: true,
        autoloadCallback: () => {
          if (this.db) {
            // 获取连接集合，如果不存在则创建
            this.connectionCollection = this.db.getCollection('connections');
            if (!this.connectionCollection) {
              this.connectionCollection = this.db.addCollection('connections', {
                indices: ['id', 'host', 'username']
              });
            }
            
            // 获取凭证集合，如果不存在则创建
            this.credentialCollection = this.db.getCollection('credentials');
            if (!this.credentialCollection) {
              this.credentialCollection = this.db.addCollection('credentials', {
                unique: ['id']
              });
            }
            
            // 加载保存的连接
            this.loadSavedConnections();
            
            this.serviceReady = true;
            resolve();
          } else {
            reject(new Error('数据库初始化失败'));
          }
        },
        autosave: true,
        autosaveInterval: 5000
      });
    });
  }
  
  // 确保服务准备就绪
  private async ensureReady(): Promise<void> {
    if (!this.serviceReady) {
      await this.serviceReadyPromise;
    }
  }
  
  // 加载保存的连接
  private async loadSavedConnections(): Promise<void> {
    if (!this.connectionCollection) return;
    
    const savedConnections = this.connectionCollection.find();
    
    for (const conn of savedConnections) {
      // 不加载密码，只保留配置
      const { id, name, config, lastUsed, tags } = conn;
      
      // 创建连接对象
      this.connections.set(id, {
        id,
        name,
        config: {
          host: config.host,
          port: config.port || parseInt(process.env.DEFAULT_SSH_PORT || '22'),
          username: config.username,
          privateKey: config.privateKey,
          keepaliveInterval: 60000,
          readyTimeout: parseInt(process.env.CONNECTION_TIMEOUT || '10000')
        },
        status: ConnectionStatus.DISCONNECTED,
        lastUsed: lastUsed ? new Date(lastUsed) : undefined,
        tags
      });
    }
  }
  
  // 创建连接ID
  private generateConnectionId(config: SSHConnectionConfig): string {
    return crypto
      .createHash('md5')
      .update(`${config.username}@${config.host}:${config.port || 22}`)
      .digest('hex');
  }
  
  // 保存连接配置
  private async saveConnection(connection: SSHConnection): Promise<void> {
    await this.ensureReady();
    
    if (!this.connectionCollection) return;
    
    // 查找现有记录
    const existing = this.connectionCollection.findOne({ id: connection.id });
    
    const connData = {
      id: connection.id,
      name: connection.name,
      config: {
        host: connection.config.host,
        port: connection.config.port,
        username: connection.config.username,
        privateKey: connection.config.privateKey
      },
      lastUsed: connection.lastUsed ? connection.lastUsed.toISOString() : new Date().toISOString(),
      tags: connection.tags || []
    };
    
    if (existing) {
      // 更新现有记录
      this.connectionCollection.update({...existing, ...connData});
    } else {
      // 添加新记录
      this.connectionCollection.insert(connData);
    }
    
    if (this.db) {
      this.db.saveDatabase();
    }
  }
  
  private async saveCredentials(id: string, password?: string, passphrase?: string): Promise<void> {
    if (this.isDocker) {
      await this.ensureReady();
      if (!this.credentialCollection) return;

      const existing = this.credentialCollection.findOne({ id });
      if (existing) {
        existing.password = password;
        existing.passphrase = passphrase;
        this.credentialCollection.update(existing);
      } else {
        this.credentialCollection.insert({ id, password, passphrase });
      }
      return;
    }
    try {
      const keytar = (await import('keytar')).default;
      if (password) {
        await keytar.setPassword('mcp-ssh', id, password);
      }
      if (passphrase) {
        await keytar.setPassword('mcp-ssh-passphrase', id, passphrase);
      }
    } catch (error) {
      console.warn(`无法保存凭证: ${error}`);
    }
  }
  
  private async getCredentials(id: string): Promise<{password?: string, passphrase?: string}> {
    if (this.isDocker) {
      await this.ensureReady();
      if (!this.credentialCollection) return {};
      const creds = this.credentialCollection.findOne({ id });
      return creds ? { password: creds.password, passphrase: creds.passphrase } : {};
    }
    try {
      const keytar = (await import('keytar')).default;
      const password = await keytar.getPassword('mcp-ssh', id);
      const passphrase = await keytar.getPassword('mcp-ssh-passphrase', id);
      return { password: password || undefined, passphrase: passphrase || undefined };
    } catch (error) {
      console.warn(`无法检索凭证: ${error}`);
      return {};
    }
  }
  
  // 连接到SSH服务器
  public async connect(config: SSHConnectionConfig, name?: string, rememberPassword: boolean = false, tags?: string[]): Promise<SSHConnection> {
    await this.ensureReady();
    
    const connectionId = this.generateConnectionId(config);
    let connection = this.connections.get(connectionId);
    
    // 如果已经连接，直接返回
    if (connection && connection.status === ConnectionStatus.CONNECTED && connection.client) {
      return connection;
    }
    
    // 如果存在连接但未连接，更新配置
    if (connection) {
      connection.config = {...connection.config, ...config};
      connection.name = name || connection.name;
      connection.tags = tags || connection.tags;
      connection.status = ConnectionStatus.CONNECTING;
    } else {
      // 创建新连接
      connection = {
        id: connectionId,
        name: name || `${config.username}@${config.host}`,
        config,
        status: ConnectionStatus.CONNECTING,
        tags,
        lastUsed: new Date()
      };
      this.connections.set(connectionId, connection);
    }
    
    try {
      // 如果没有提供密码，尝试从keytar获取
      if (!config.password && !config.privateKey) {
        const savedCredentials = await this.getCredentials(connectionId);
        if (savedCredentials.password) {
          config.password = savedCredentials.password;
        }
        if (savedCredentials.passphrase) {
          config.passphrase = savedCredentials.passphrase;
        }
      }
      
      // 创建SSH客户端
      const ssh = new NodeSSH();
      
      // 连接选项
      const connectOptions = {
        host: config.host,
        port: config.port || parseInt(process.env.DEFAULT_SSH_PORT || '22'),
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
        keepaliveInterval: config.keepaliveInterval || 60000,
        readyTimeout: config.readyTimeout || parseInt(process.env.CONNECTION_TIMEOUT || '10000')
      };
      
      // 连接
      await ssh.connect(connectOptions);
      
      // 连接成功，更新状态
      connection.client = ssh;
      connection.status = ConnectionStatus.CONNECTED;
      connection.lastUsed = new Date();
      connection.lastError = undefined;
      connection.currentDirectory = await this.getCurrentDirectory(connectionId);
      
      // 如果配置了记住密码，保存凭据
      if (rememberPassword) {
        await this.saveCredentials(connectionId, config.password, config.passphrase);
      }
      
      // 保存连接到数据库
      await this.saveConnection(connection);
      
      return connection;
    } catch (error) {
      // 连接失败
      connection.status = ConnectionStatus.ERROR;
      connection.lastError = error instanceof Error ? error.message : String(error);
      
      // 如果配置了自动重连，尝试重连
      if (config.reconnect && config.reconnectTries && config.reconnectTries > 0) {
        this.scheduleReconnect(connectionId, config);
      }
      
      throw error;
    }
  }
  
  // 计划重连
  private scheduleReconnect(connectionId: string, config: SSHConnectionConfig): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    // 设置状态为重连中
    connection.status = ConnectionStatus.RECONNECTING;
    
    // 计算重连次数和延迟
    const reconnectTries = config.reconnectTries || parseInt(process.env.RECONNECT_ATTEMPTS || '3');
    const reconnectDelay = config.reconnectDelay || 5000;
    
    let attempts = 0;
    
    const attemptReconnect = async () => {
      attempts++;
      
      try {
        // 尝试重连
        await this.connect(config);
        // 重连成功
        console.log(`成功重新连接到 ${config.host}`);
      } catch (error) {
        // 重连失败
        console.error(`重连尝试 ${attempts}/${reconnectTries} 失败:`, error);
        
        // 如果还有重连次数，继续尝试
        if (attempts < reconnectTries) {
          setTimeout(attemptReconnect, reconnectDelay);
        } else {
          // 重连次数耗尽，设置状态为错误
          const failedConnection = this.connections.get(connectionId);
          if (failedConnection) {
            failedConnection.status = ConnectionStatus.ERROR;
          }
        }
      }
    };
    
    // 开始第一次重连尝试
    setTimeout(attemptReconnect, reconnectDelay);
  }
  
  // 断开连接
  public async disconnect(connectionId: string): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client) {
      return false;
    }
    
    try {
      // 断开SSH连接
      await connection.client.dispose();
      
      // 更新状态
      connection.status = ConnectionStatus.DISCONNECTED;
      connection.client = undefined;
      
      return true;
    } catch (error) {
      console.error(`断开连接 ${connectionId} 时出错:`, error);
      
      // 即使出错也要更新状态
      connection.status = ConnectionStatus.ERROR;
      connection.lastError = error instanceof Error ? error.message : String(error);
      
      return false;
    }
  }
  
  // 获取所有连接
  public async getAllConnections(): Promise<SSHConnection[]> {
    await this.ensureReady();
    return Array.from(this.connections.values());
  }
  
  // 获取特定连接
  public getConnection(connectionId: string): SSHConnection | undefined {
    return this.connections.get(connectionId);
  }
  
  // 执行命令
  public async executeCommand(connectionId: string, command: string, options?: { cwd?: string, timeout?: number }): Promise<CommandResult> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }
    
    try {
      // 准备选项
      const execOptions: any = {};
      
      // 工作目录
      if (options?.cwd) {
        execOptions.cwd = options.cwd;
      } else if (connection.currentDirectory) {
        execOptions.cwd = connection.currentDirectory;
      }
      
      // 超时
      if (options?.timeout) {
        execOptions.execOptions = { timeout: options.timeout };
      } else if (process.env.COMMAND_TIMEOUT && parseInt(process.env.COMMAND_TIMEOUT) > 0) {
        execOptions.execOptions = { timeout: parseInt(process.env.COMMAND_TIMEOUT) };
      }

      // 检查是否是sudo命令
      if (command.trim().startsWith('sudo ') || command.includes(' sudo ')) {
        // 尝试获取密码
        let password = connection.config.password;
        if (!password) {
          const savedCredentials = await this.getCredentials(connection.id);
          password = savedCredentials.password;
        }

        // 如果有密码，使用echo密码 | sudo -S 的方式运行
        if (password) {
          // 修改命令以自动提供密码
          // 使用 -S 标志让sudo从标准输入读取密码
          const sudoCommand = command.replace(/\bsudo\b/g, 'sudo -S');
          // 使用echo和管道传递密码，并添加命令使sudo在用户输入时不显示
          command = `echo "${password}" | ${sudoCommand} 2>/dev/null`;
        }
      }
      
      // 执行命令
      const result = await connection.client.execCommand(command, execOptions);
      
      // 更新当前目录（如果是cd命令）
      if (command.trim().startsWith('cd ')) {
        connection.currentDirectory = await this.getCurrentDirectory(connectionId);
      }
      
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code as number
      };
    } catch (error) {
      // 处理错误
      console.error(`在连接 ${connectionId} 上执行命令时出错:`, error);
      
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        code: 1
      };
    }
  }
  
  // 在后台执行命令
  public async executeBackgroundCommand(connectionId: string, command: string, options?: { cwd?: string, interval?: number }): Promise<string> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }
    
    try {
      // 准备选项
      const execOptions: any = {};
      
      // 工作目录
      if (options?.cwd) {
        execOptions.cwd = options.cwd;
      } else if (connection.currentDirectory) {
        execOptions.cwd = connection.currentDirectory;
      }

      // 检查是否是sudo命令
      if (command.trim().startsWith('sudo ') || command.includes(' sudo ')) {
        // 尝试获取密码
        let password = connection.config.password;
        if (!password) {
          const savedCredentials = await this.getCredentials(connection.id);
          password = savedCredentials.password;
        }

        // 如果有密码，使用echo密码 | sudo -S 的方式运行
        if (password) {
          // 修改命令以自动提供密码
          // 使用 -S 标志让sudo从标准输入读取密码
          const sudoCommand = command.replace(/\bsudo\b/g, 'sudo -S');
          // 使用echo和管道传递密码，并添加命令使sudo在用户输入时不显示
          command = `echo "${password}" | ${sudoCommand} 2>/dev/null`;
        }
      }
      
      // 创建一个唯一任务ID
      const taskId = crypto
        .createHash('md5')
        .update(`${connectionId}:${command}:${Date.now()}`)
        .digest('hex');
      
      // 启动后台进程
      const process = await connection.client.exec(command, [], {
        cwd: execOptions.cwd,
        stream: 'both',
        onStdout: (chunk) => {
          const task = this.backgroundTasks.get(taskId);
          if (task) {
            task.output += chunk.toString('utf8');
            this.eventEmitter.emit('task-update', { id: taskId, output: task.output });
          }
        },
        onStderr: (chunk) => {
          const task = this.backgroundTasks.get(taskId);
          if (task) {
            task.output += chunk.toString('utf8');
            this.eventEmitter.emit('task-update', { id: taskId, output: task.output });
          }
        }
      });
      
      // 记录任务信息
      const task: BackgroundTask = {
        client: connection.client,
        process,
        output: '',
        isRunning: true,
        startTime: new Date()
      };
      
      this.backgroundTasks.set(taskId, task);
      
      // 处理进程结束
      if (process && typeof process === 'object' && process.hasOwnProperty('code')) {
        // 如果已经有code属性，表示进程已经结束
        const code = (process as any).code;
        task.isRunning = false;
        task.exitCode = typeof code === 'number' ? code : 0;
        task.endTime = new Date();
        
        this.eventEmitter.emit('task-end', { 
          id: taskId, 
          output: task.output, 
          exitCode: task.exitCode,
          startTime: task.startTime,
          endTime: task.endTime
        });
      } else {
        // 监听进程的子事件来检测完成
        // node-ssh的exec返回有可能不包含标准属性，所以使用一个定时器来检查任务是否完成
        const checkInterval = setInterval(() => {
          const currentTask = this.backgroundTasks.get(taskId);
          if (currentTask && currentTask.isRunning && process && 
              typeof process === 'object' && process.hasOwnProperty('code')) {
            // 进程已完成
            clearInterval(checkInterval);
            
            const code = (process as any).code;
            currentTask.isRunning = false;
            currentTask.exitCode = typeof code === 'number' ? code : 0;
            currentTask.endTime = new Date();
            
            // 停止间隔发送
            if (currentTask.interval) {
              clearInterval(currentTask.interval);
              currentTask.interval = undefined;
            }
            
            this.eventEmitter.emit('task-end', { 
              id: taskId, 
              output: currentTask.output, 
              exitCode: currentTask.exitCode,
              startTime: currentTask.startTime,
              endTime: currentTask.endTime
            });
          }
        }, 1000); // 每秒检查一次
        
        // 5分钟后强制结束检查，避免无限循环
        setTimeout(() => {
          clearInterval(checkInterval);
          const currentTask = this.backgroundTasks.get(taskId);
          if (currentTask && currentTask.isRunning) {
            // 强制标记为已完成
            currentTask.isRunning = false;
            currentTask.exitCode = -1; // 表示超时
            currentTask.endTime = new Date();
            
            // 停止间隔发送
            if (currentTask.interval) {
              clearInterval(currentTask.interval);
              currentTask.interval = undefined;
            }
            
            this.eventEmitter.emit('task-end', { 
              id: taskId, 
              output: currentTask.output, 
              exitCode: currentTask.exitCode,
              startTime: currentTask.startTime,
              endTime: currentTask.endTime
            });
          }
        }, 5 * 60 * 1000); // 5分钟
      }
      
      // 如果设置了间隔，定期发送输出
      if (options?.interval) {
        const interval = setInterval(() => {
          const task = this.backgroundTasks.get(taskId);
          if (task && task.isRunning) {
            this.eventEmitter.emit('task-update', { 
              id: taskId, 
              output: task.output,
              isRunning: true,
              startTime: task.startTime
            });
          } else {
            clearInterval(interval);
          }
        }, options.interval);
        
        const task = this.backgroundTasks.get(taskId);
        if (task) {
          task.interval = interval;
        }
      }
      
      return taskId;
    } catch (error) {
      console.error(`在连接 ${connectionId} 上启动后台命令时出错:`, error);
      throw error;
    }
  }
  
  // 停止后台任务
  public async stopBackgroundTask(taskId: string): Promise<boolean> {
    const task = this.backgroundTasks.get(taskId);
    if (!task || !task.isRunning) {
      return false;
    }
    
    try {
      // 发送SIGTERM信号
      task.process.signal('SIGTERM');
      
      // 给进程一些时间响应信号
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 如果仍在运行，尝试SIGKILL
      if (task.isRunning) {
        task.process.signal('SIGKILL');
      }
      
      // 更新状态
      task.isRunning = false;
      task.endTime = new Date();
      task.error = '任务被强制终止';
      
      // 停止间隔发送
      if (task.interval) {
        clearInterval(task.interval);
        task.interval = undefined;
      }
      
      this.eventEmitter.emit('task-end', { 
        id: taskId, 
        output: task.output, 
        error: task.error,
        startTime: task.startTime,
        endTime: task.endTime
      });
      
      return true;
    } catch (error) {
      console.error(`停止后台任务 ${taskId} 时出错:`, error);
      return false;
    }
  }
  
  // 获取后台任务信息
  public getBackgroundTaskInfo(taskId: string): BackgroundTaskResult | undefined {
    const task = this.backgroundTasks.get(taskId);
    if (!task) {
      return undefined;
    }
    
    return {
      id: taskId,
      output: task.output,
      isRunning: task.isRunning,
      exitCode: task.exitCode,
      error: task.error,
      startTime: task.startTime,
      endTime: task.endTime
    };
  }
  
  // 获取所有后台任务
  public getAllBackgroundTasks(): BackgroundTaskResult[] {
    const results: BackgroundTaskResult[] = [];
    
    for (const [id, task] of this.backgroundTasks.entries()) {
      results.push({
        id,
        output: task.output,
        isRunning: task.isRunning,
        exitCode: task.exitCode,
        error: task.error,
        startTime: task.startTime,
        endTime: task.endTime
      });
    }
    
    return results;
  }
  
  // 上传文件（带进度）
  public async uploadFile(connectionId: string, localPath: string, remotePath: string): Promise<FileTransferInfo> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }
    
    // 创建传输ID
    const transferId = crypto
      .createHash('md5')
      .update(`upload:${connectionId}:${localPath}:${remotePath}:${Date.now()}`)
      .digest('hex');
    
    try {
      // 检查源文件
      const stats = fs.statSync(localPath);
      if (!stats.isFile()) {
        throw new Error(`本地路径 ${localPath} 不是一个文件`);
      }
      
      // 创建传输信息
      const transferInfo: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'upload',
        status: 'pending',
        progress: 0,
        size: stats.size,
        bytesTransferred: 0,
        startTime: new Date()
      };
      
      // 保存传输信息
      this.fileTransfers.set(transferId, transferInfo);
      
      // 使用SFTPStream上传文件
      const sftp = await connection.client.requestSFTP();
      
      await new Promise<void>((resolve, reject) => {
        // 更新传输状态
        transferInfo.status = 'in-progress';
        this.eventEmitter.emit('transfer-start', transferInfo);
        
        // 创建读取流
        const readStream = fs.createReadStream(localPath);
        
        // 创建写入流
        const writeStream = sftp.createWriteStream(remotePath);
        
        // 跟踪传输的字节数
        let bytesTransferred = 0;
        
        // 监听读取数据事件
        readStream.on('data', (chunk: string | Buffer) => {
          bytesTransferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk).length;
          
          // 更新进度
          transferInfo.bytesTransferred = bytesTransferred;
          transferInfo.progress = Math.min(100, Math.round((bytesTransferred / stats.size) * 100));
          
          // 发出进度事件
          this.eventEmitter.emit('transfer-progress', transferInfo);
        });
        
        // 处理错误
        readStream.on('error', (err: Error) => {
          transferInfo.status = 'failed';
          transferInfo.error = err.message;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-error', transferInfo);
          reject(err);
        });
        
        writeStream.on('error', (err: Error) => {
          transferInfo.status = 'failed';
          transferInfo.error = err.message;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-error', transferInfo);
          readStream.destroy();
          reject(err);
        });
        
        // 处理完成
        writeStream.on('close', () => {
          transferInfo.status = 'completed';
          transferInfo.progress = 100;
          transferInfo.bytesTransferred = stats.size;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-complete', transferInfo);
          resolve();
        });
        
        // 连接流
        readStream.pipe(writeStream);
      });
      
      return this.fileTransfers.get(transferId) as FileTransferInfo;
    } catch (error) {
      console.error(`上传文件到连接 ${connectionId} 时出错:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // 如果已经创建了传输记录，更新为失败状态
      if (this.fileTransfers.has(transferId)) {
        const transferInfo = this.fileTransfers.get(transferId)!;
        transferInfo.status = 'failed';
        transferInfo.error = errorMessage;
        transferInfo.endTime = new Date();
        this.eventEmitter.emit('transfer-error', transferInfo);
        return transferInfo;
      }
      
      // 创建失败的传输记录
      const failedTransfer: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'upload',
        status: 'failed',
        progress: 0,
        size: 0,
        bytesTransferred: 0,
        error: errorMessage,
        startTime: new Date(),
        endTime: new Date()
      };
      
      this.fileTransfers.set(transferId, failedTransfer);
      this.eventEmitter.emit('transfer-error', failedTransfer);
      
      return failedTransfer;
    }
  }
  
  // 下载文件（带进度）
  public async downloadFile(connectionId: string, remotePath: string, localPath: string): Promise<FileTransferInfo> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }
    
    // 创建传输ID
    const transferId = crypto
      .createHash('md5')
      .update(`download:${connectionId}:${remotePath}:${localPath}:${Date.now()}`)
      .digest('hex');
    
    try {
      // 创建本地目录
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      
      // 获取SFTP
      const sftp = await connection.client.requestSFTP();
      
      // 获取远程文件大小
      const stats = await new Promise<any>((resolve, reject) => {
        sftp.stat(remotePath, (err: Error | undefined, stats: any) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stats);
        });
      });
      
      // 创建传输信息
      const transferInfo: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'download',
        status: 'pending',
        progress: 0,
        size: stats.size,
        bytesTransferred: 0,
        startTime: new Date()
      };
      
      // 保存传输信息
      this.fileTransfers.set(transferId, transferInfo);
      
      await new Promise<void>((resolve, reject) => {
        // 更新传输状态
        transferInfo.status = 'in-progress';
        this.eventEmitter.emit('transfer-start', transferInfo);
        
        // 创建读取流
        const readStream = sftp.createReadStream(remotePath);
        
        // 创建写入流
        const writeStream = fs.createWriteStream(localPath);
        
        // 跟踪传输的字节数
        let bytesTransferred = 0;
        
        // 监听读取数据事件
        readStream.on('data', (chunk: string | Buffer) => {
          bytesTransferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk).length;
          
          // 更新进度
          transferInfo.bytesTransferred = bytesTransferred;
          transferInfo.progress = Math.min(100, Math.round((bytesTransferred / stats.size) * 100));
          
          // 发出进度事件
          this.eventEmitter.emit('transfer-progress', transferInfo);
        });
        
        // 处理错误
        readStream.on('error', (err: Error) => {
          transferInfo.status = 'failed';
          transferInfo.error = err.message;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-error', transferInfo);
          writeStream.close();
          reject(err);
        });
        
        writeStream.on('error', (err: Error) => {
          transferInfo.status = 'failed';
          transferInfo.error = err.message;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-error', transferInfo);
          readStream.destroy();
          reject(err);
        });
        
        // 处理完成
        writeStream.on('close', () => {
          transferInfo.status = 'completed';
          transferInfo.progress = 100;
          transferInfo.bytesTransferred = stats.size;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-complete', transferInfo);
          resolve();
        });
        
        // 连接流
        readStream.pipe(writeStream);
      });
      
      return this.fileTransfers.get(transferId) as FileTransferInfo;
    } catch (error) {
      console.error(`从连接 ${connectionId} 下载文件时出错:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // 如果已经创建了传输记录，更新为失败状态
      if (this.fileTransfers.has(transferId)) {
        const transferInfo = this.fileTransfers.get(transferId)!;
        transferInfo.status = 'failed';
        transferInfo.error = errorMessage;
        transferInfo.endTime = new Date();
        this.eventEmitter.emit('transfer-error', transferInfo);
        return transferInfo;
      }
      
      // 创建失败的传输记录
      const failedTransfer: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'download',
        status: 'failed',
        progress: 0,
        size: 0,
        bytesTransferred: 0,
        error: errorMessage,
        startTime: new Date(),
        endTime: new Date()
      };
      
      this.fileTransfers.set(transferId, failedTransfer);
      this.eventEmitter.emit('transfer-error', failedTransfer);
      
      return failedTransfer;
    }
  }
  
  // 批量传输文件
  public async batchTransfer(config: BatchTransferConfig): Promise<string[]> {
    const { connectionId, items, direction } = config;
    
    // 检查连接
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }
    
    const transferIds: string[] = [];
    const errors: Error[] = [];
    
    // 按顺序处理每个项目
    for (const item of items) {
      try {
        let transferInfo: FileTransferInfo;
        
        if (direction === 'upload') {
          transferInfo = await this.uploadFile(connectionId, item.localPath, item.remotePath);
        } else {
          transferInfo = await this.downloadFile(connectionId, item.remotePath, item.localPath);
        }
        
        transferIds.push(transferInfo.id);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
        console.error(`批量传输过程中出错:`, error);
      }
    }
    
    // 如果所有传输都失败，抛出错误
    if (errors.length === items.length) {
      throw new Error(`批量传输完全失败: ${errors.map(e => e.message).join(', ')}`);
    }
    
    // 返回成功的传输ID
    return transferIds;
  }
  
  // 获取传输信息
  public getTransferInfo(transferId: string): FileTransferInfo | undefined {
    return this.fileTransfers.get(transferId);
  }
  
  // 获取所有传输
  public getAllTransfers(): FileTransferInfo[] {
    return Array.from(this.fileTransfers.values());
  }
  
  // 注册进度回调
  public onTransferProgress(callback: (info: FileTransferInfo) => void): () => void {
    this.eventEmitter.on('transfer-progress', callback);
    return () => {
      this.eventEmitter.off('transfer-progress', callback);
    };
  }
  
  // 注册完成回调
  public onTransferComplete(callback: (info: FileTransferInfo) => void): () => void {
    this.eventEmitter.on('transfer-complete', callback);
    return () => {
      this.eventEmitter.off('transfer-complete', callback);
    };
  }
  
  // 注册错误回调
  public onTransferError(callback: (info: FileTransferInfo) => void): () => void {
    this.eventEmitter.on('transfer-error', callback);
    return () => {
      this.eventEmitter.off('transfer-error', callback);
    };
  }
  
  // 获取当前目录
  private async getCurrentDirectory(connectionId: string): Promise<string> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }
    
    try {
      const result = await connection.client.execCommand('pwd');
      return result.stdout.trim();
    } catch (error) {
      console.error(`获取当前目录时出错:`, error);
      return '';
    }
  }
  
  // 删除连接
  public async deleteConnection(connectionId: string): Promise<boolean> {
    await this.ensureReady();
    
    // 断开连接
    await this.disconnect(connectionId);
    
    // 从数据库中删除
    if (this.connectionCollection) {
      this.connectionCollection.findAndRemove({ id: connectionId });
    }
    
    // 从内存中删除
    this.connections.delete(connectionId);
    
    // 删除凭据
    if (!this.isDocker) {
      try {
        const keytar = (await import('keytar')).default;
        await keytar.deletePassword('mcp-ssh', connectionId);
        await keytar.deletePassword('mcp-ssh-passphrase', connectionId);
      } catch (error) {
        console.warn(`无法删除凭证: ${error}`);
      }
    } else {
      await this.ensureReady();
      if (this.credentialCollection) {
        this.credentialCollection.findAndRemove({ id: connectionId });
      }
    }
    
    return true;
  }
  
  // 创建SSH隧道
  public async createTunnel(config: TunnelConfig): Promise<string> {
    const connection = this.connections.get(config.connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${config.connectionId} 不可用或未连接`);
    }
    
    // 生成隧道ID
    const tunnelId = config.id || crypto
      .createHash('md5')
      .update(`${config.connectionId}:${config.localPort}:${config.remoteHost}:${config.remotePort}:${Date.now()}`)
      .digest('hex');
    
    // 检查端口是否已在使用
    const existingTunnel = Array.from(this.tunnels.values())
      .find(t => t.config.localPort === config.localPort && t.isActive);
    
    if (existingTunnel) {
      throw new Error(`本地端口 ${config.localPort} 已被另一个隧道使用`);
    }
    
    try {
      // 创建本地服务器
      const server = net.createServer();
      
      // 记录活动连接
      const connections = new Set<net.Socket>();
      
      // 设置隧道信息
      this.tunnels.set(tunnelId, {
        config: {
          ...config,
          id: tunnelId
        },
        server,
        connections,
        isActive: false
      });
      
      // 设置连接处理
      server.on('connection', (socket) => {
        connections.add(socket);
        
        // 当连接结束时，从集合中删除
        socket.on('close', () => {
          connections.delete(socket);
        });
        
        // 处理错误
        socket.on('error', (err) => {
          console.error(`隧道 ${tunnelId} 上的本地套接字错误:`, err);
          connections.delete(socket);
          socket.destroy();
        });
        
        // 创建到SSH服务器的连接
        const sshClient = connection.client;
        if (!sshClient) {
          socket.destroy();
          connections.delete(socket);
          return;
        }
        
        // 创建到远程主机的连接
        sshClient.forwardOut(
          '127.0.0.1',
          socket.remotePort || 0,
          config.remoteHost,
          config.remotePort
        ).then((stream) => {
          // 将本地套接字连接到SSH流
          socket.pipe(stream);
          stream.pipe(socket);
          
          // 处理错误
          stream.on('error', (err: Error) => {
            console.error(`隧道 ${tunnelId} 上的SSH流错误:`, err);
            // 确保我们从集合中移除socket
            connections.delete(socket);
            socket.destroy();
          });
          
          socket.on('error', (err: Error) => {
            console.error(`隧道 ${tunnelId} 上的本地套接字错误:`, err);
            stream.destroy();
          });
          
          // 处理关闭
          stream.on('close', () => {
            connections.delete(socket);
            socket.destroy();
          });
          
          socket.on('close', () => {
            stream.destroy();
          });
        }).catch((err) => {
          console.error(`为隧道 ${tunnelId} 创建转发时出错:`, err);
          connections.delete(socket);
          socket.destroy();
        });
      });
      
      // 启动服务器
      await new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen(config.localPort, '127.0.0.1', () => {
          const tunnel = this.tunnels.get(tunnelId);
          if (tunnel) {
            tunnel.isActive = true;
          }
          resolve();
        });
      });
      
      // 返回隧道ID
      return tunnelId;
    } catch (error) {
      // 清理失败的隧道
      this.closeTunnel(tunnelId).catch(() => {});
      console.error(`创建隧道时出错:`, error);
      throw error;
    }
  }
  
  // 关闭SSH隧道
  public async closeTunnel(tunnelId: string): Promise<boolean> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) {
      return false;
    }
    
    try {
      // 关闭所有活动连接
      for (const socket of tunnel.connections) {
        // 先移除所有事件监听器
        socket.removeAllListeners();
        // 然后关闭连接
        socket.destroy();
      }
      
      // 清空连接集合
      tunnel.connections.clear();
      
      // 关闭服务器
      if (tunnel.server) {
        // 移除所有事件监听器
        tunnel.server.removeAllListeners();
        
        await new Promise<void>((resolve) => {
          tunnel.server?.close(() => resolve());
        });
      }
      
      // 更新状态
      tunnel.isActive = false;
      
      // 移除隧道
      this.tunnels.delete(tunnelId);
      
      return true;
    } catch (error) {
      console.error(`关闭隧道 ${tunnelId} 时出错:`, error);
      return false;
    }
  }
  
  // 获取所有隧道
  public getTunnels(): TunnelConfig[] {
    return Array.from(this.tunnels.values())
      .filter(t => t.isActive)
      .map(t => t.config);
  }
  
  // 创建终端会话
  public async createTerminalSession(connectionId: string, config?: TerminalSessionConfig): Promise<string> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }
    
    try {
      // 生成会话ID
      const sessionId = crypto
        .createHash('md5')
        .update(`terminal:${connectionId}:${Date.now()}`)
        .digest('hex');
      
      // 终端配置
      const termConfig = {
        rows: config?.rows || 24,
        cols: config?.cols || 80,
        term: config?.term || 'xterm-256color'
      };
      
      // 创建Shell会话
      const ssh2Client = (connection.client as any).connection;
      if (!ssh2Client) {
        throw new Error(`无法获取底层SSH2连接`);
      }
      
      // 创建Shell请求
      const stream = await new Promise<any>((resolve, reject) => {
        ssh2Client.shell({
          term: termConfig.term,
          rows: termConfig.rows,
          cols: termConfig.cols,
          height: termConfig.rows,
          width: termConfig.cols
        }, (err: Error | undefined, stream: any) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stream);
        });
      });
      
      // 创建会话记录
      const session: TerminalSession = {
        id: sessionId,
        connectionId,
        stream,
        rows: termConfig.rows,
        cols: termConfig.cols,
        term: termConfig.term,
        isActive: true,
        startTime: new Date(),
        lastActivity: new Date(),
        sudoPasswordPrompt: false
      };
      
      // 保存会话
      this.terminalSessions.set(sessionId, session);
      
      // 设置数据处理
      stream.on('data', (data: Buffer) => {
        const dataStr = data.toString('utf8');
        
        // 检测是否是sudo密码提示
        if (dataStr.includes('[sudo] password for') || 
            dataStr.includes('Password:') || 
            dataStr.includes('密码：')) {
          // 标记为sudo密码提示
          session.sudoPasswordPrompt = true;
          
          // 获取密码
          const connection = this.connections.get(connectionId);
          if (connection) {
            // 尝试直接从连接获取密码
            let password = connection.config.password;
            if (!password) {
              // 如果连接对象中没有密码，从凭据存储获取
              this.getCredentials(connection.id).then(credentials => {
                if (credentials.password) {
                  // 自动提供密码
                  stream.write(`${credentials.password}\n`);
                }
              }).catch(err => {
                console.error('获取SSH密码时出错:', err);
              });
            } else {
              // 直接提供密码
              stream.write(`${password}\n`);
            }
          }
        }
        
        this.eventEmitter.emit('terminal-data', {
          sessionId,
          data: dataStr
        });
        
        // 更新最后活动时间
        const currentSession = this.terminalSessions.get(sessionId);
        if (currentSession) {
          currentSession.lastActivity = new Date();
        }
      });
      
      // 处理流关闭
      stream.on('close', () => {
        this.closeTerminalSession(sessionId).catch(err => {
          console.error(`关闭终端会话 ${sessionId} 时出错:`, err);
        });
      });
      
      return sessionId;
    } catch (error) {
      console.error(`创建终端会话时出错:`, error);
      throw error;
    }
  }
  
  // 向终端写入数据
  public async writeToTerminal(sessionId: string, data: string): Promise<boolean> {
    const session = this.terminalSessions.get(sessionId);
    if (!session || !session.isActive) {
      return false;
    }
    
    try {
      // 检查是否是sudo密码提示
      if (session.sudoPasswordPrompt) {
        // 重置sudo密码提示标志
        session.sudoPasswordPrompt = false;
        
        // 获取密码
        const connection = this.connections.get(session.connectionId);
        if (connection) {
          let password = connection.config.password;
          if (!password) {
            const savedCredentials = await this.getCredentials(connection.id);
            password = savedCredentials.password;
          }
          
          // 如果有密码，自动提供
          if (password) {
            // 发送密码并回车
            session.stream.write(`${password}\n`);
            return true;
          }
        }
      }
      
      // 正常写入数据
      session.stream.write(data);
      
      // 更新最后活动时间
      session.lastActivity = new Date();
      
      return true;
    } catch (error) {
      console.error(`向终端写入数据时出错:`, error);
      return false;
    }
  }
  
  // 调整终端大小
  public async resizeTerminal(sessionId: string, rows: number, cols: number): Promise<boolean> {
    const session = this.terminalSessions.get(sessionId);
    if (!session || !session.isActive) {
      throw new Error(`终端会话 ${sessionId} 不存在或不活跃`);
    }
    
    try {
      // 更新大小
      session.rows = rows;
      session.cols = cols;
      
      // 更新最后活动时间
      session.lastActivity = new Date();
      
      // 调整终端大小
      session.stream.setWindow(rows, cols, 0, 0);
      
      return true;
    } catch (error) {
      console.error(`调整终端会话 ${sessionId} 大小时出错:`, error);
      return false;
    }
  }
  
  // 关闭终端会话
  public async closeTerminalSession(sessionId: string): Promise<boolean> {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      return false;
    }
    
    try {
      // 结束流并移除所有事件监听器
      if (session.stream && session.isActive) {
        // 先移除所有事件监听器，避免内存泄漏
        session.stream.removeAllListeners();
        // 然后关闭流
        session.stream.end();
        session.isActive = false;
      }
      
      // 删除会话
      this.terminalSessions.delete(sessionId);
      
      // 发出关闭事件
      this.eventEmitter.emit('terminal-close', { sessionId });
      
      return true;
    } catch (error) {
      console.error(`关闭终端会话 ${sessionId} 时出错:`, error);
      return false;
    }
  }
  
  // 获取终端会话信息
  public getTerminalSession(sessionId: string): Omit<TerminalSession, 'stream'> | undefined {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    
    // 排除流对象
    const { stream, ...sessionInfo } = session;
    return sessionInfo;
  }
  
  // 获取所有终端会话
  public getAllTerminalSessions(): Omit<TerminalSession, 'stream'>[] {
    const sessions: Omit<TerminalSession, 'stream'>[] = [];
    
    for (const session of this.terminalSessions.values()) {
      const { stream, ...sessionInfo } = session;
      sessions.push(sessionInfo);
    }
    
    return sessions;
  }
  
  // 注册终端数据事件
  public onTerminalData(callback: (event: TerminalDataEvent) => void): () => void {
    this.eventEmitter.on('terminal-data', callback);
    return () => {
      this.eventEmitter.off('terminal-data', callback);
    };
  }
  
  // 注册终端关闭事件
  public onTerminalClose(callback: (event: { sessionId: string }) => void): () => void {
    this.eventEmitter.on('terminal-close', callback);
    return () => {
      this.eventEmitter.off('terminal-close', callback);
    };
  }
  
  // 设置定期清理任务
  private setupCleanupTasks(): void {
    // 每小时清理一次已完成的传输记录
    setInterval(() => {
      this.cleanupCompletedTransfers();
    }, 60 * 60 * 1000); // 1小时
    
    // 每天清理一次长时间不活跃的资源
    setInterval(() => {
      this.cleanupInactiveResources();
    }, 24 * 60 * 60 * 1000); // 24小时
  }
  
  // 清理已完成的传输记录
  private cleanupCompletedTransfers(): void {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000); // 1小时前
    
    for (const [id, transfer] of this.fileTransfers.entries()) {
      // 清理一小时前已完成或失败的传输
      if ((transfer.status === 'completed' || transfer.status === 'failed') && 
          transfer.endTime && new Date(transfer.endTime) < oneHourAgo) {
        this.fileTransfers.delete(id);
      }
    }
    
    console.log(`已清理完成的文件传输记录，当前剩余: ${this.fileTransfers.size}`);
  }
  
  // 清理不活跃的资源
  private cleanupInactiveResources(): void {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24小时前
    
    // 清理长时间不活跃的终端会话
    for (const [id, session] of this.terminalSessions.entries()) {
      if (session.lastActivity < oneDayAgo) {
        this.closeTerminalSession(id).catch(err => {
          console.error(`自动清理终端会话 ${id} 时出错:`, err);
        });
      }
    }
    
    // 清理长时间不活跃的隧道
    for (const tunnelId of this.tunnels.keys()) {
      // 隧道没有活动时间记录，暂时不清理
      // 未来可以添加活动时间跟踪
    }
    
    console.log(`已清理不活跃资源，当前终端会话: ${this.terminalSessions.size}, 隧道: ${this.tunnels.size}`);
  }
  
  // 关闭服务
  public async close(): Promise<void> {
    // 关闭所有终端会话
    for (const sessionId of this.terminalSessions.keys()) {
      await this.closeTerminalSession(sessionId);
    }
    
    // 关闭所有隧道
    for (const tunnelId of this.tunnels.keys()) {
      await this.closeTunnel(tunnelId);
    }
    
    // 停止所有后台任务
    for (const taskId of this.backgroundTasks.keys()) {
      await this.stopBackgroundTask(taskId);
    }
    
    // 断开所有连接
    for (const [id, connection] of this.connections.entries()) {
      if (connection.status === ConnectionStatus.CONNECTED && connection.client) {
        await this.disconnect(id);
      }
    }
    
    // 保存数据库
    if (this.db) {
      this.db.saveDatabase();
    }
  }
} 
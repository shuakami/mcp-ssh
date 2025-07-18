# SSH MCP 工具

[![ISC License](https://img.shields.io/badge/License-ISC-718096?style=flat-square)](https://opensource.org/licenses/ISC)
[![Node.js](https://img.shields.io/badge/Node.js-18.x-339933?style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![SSH](https://img.shields.io/badge/SSH-MCP-0078d7?style=flat-square)](https://github.com/shuakami/mcp-ssh)

[English Version (README-EN.md)](README-EN.md)

## 这是什么

这是一个基于 MCP (Model Context Protocol) 的 SSH 工具，它能让 AI 模型通过标准化接口访问和管理 SSH 连接。

简单来说，它让 AI 助手能够执行各种 SSH 操作，如连接服务器、执行命令、管理文件等，无需用户手动输入复杂的命令或切换到终端。

<details>
<summary><b>支持的功能</b> (点击展开)</summary>

- **连接管理**：创建、获取、列表、更新、删除 SSH 连接
- **命令执行**：执行单条命令、复合命令、后台任务
- **tmux 会话管理**：创建、获取、列表、发送按键、捕获输出
- **文件操作**：上传、下载、查看文件内容
- **进程管理**：检测阻塞进程、智能等待、超时处理
- **安全控制**：密码/密钥认证、超时控制、错误处理
</details>

<details>
<summary><b>功能特点</b> (点击展开)</summary>

以下是 SSH MCP 工具的一些核心特点：

- **智能命令执行**：自动检测并等待阻塞进程，避免会话卡死
- **tmux 集成**：完整支持 tmux 会话管理，实现持久化终端会话
- **复合命令支持**：智能处理包含 `&&` 和 `;` 的复合命令
- **实时反馈**：命令执行状态实时更新，支持长时间运行的任务
- **错误恢复**：自动处理断线重连、超时等异常情况
- **安全可靠**：支持多种认证方式，保护敏感信息

通过简单的自然语言指令，AI 可以帮助你完成上述所有操作，无需手动编写复杂的 SSH 命令或在终端中执行操作。
</details>

## 快速上手

### 0. 环境准备

<details>
<summary>环境要求 (点击展开)</summary>

1. **Python 3.11+（必需）**
   - 访问 [Python 官网](https://www.python.org/downloads/)
   - 下载并安装 Python 3.11 或更高版本
   - **重要**：安装时请勾选"Add Python to PATH"选项
   - **安装完成后请重启电脑**，确保环境变量生效

2. **Node.js 和 npm**
   - 访问 [Node.js 官网](https://nodejs.org/)
   - 下载并安装 LTS（长期支持）版本
   - 安装时选择默认选项即可，安装包会同时安装 Node.js 和 npm

3. **Git**
   - 访问 [Git 官网](https://git-scm.com/)
   - 下载并安装 Git
   - 安装时使用默认选项即可
   
4. **tmux** (远程服务器需要)
   - 在远程服务器上安装 tmux
   - 对于 Ubuntu/Debian: `sudo apt-get install tmux`
   - 对于 CentOS/RHEL: `sudo yum install tmux`
</details>

### 1. 克隆并安装

```bash
git clone https://github.com/shuakami/mcp-ssh.git
cd mcp-ssh
npm install
npm run build
```
> ⚠️ **重要提示**：安装后请不要删除克隆或解压的文件，插件需要持续访问这些文件！

### 2. 构建项目

```bash
npm run build
```

### 3. 添加到 Cursor MCP 配置

根据你的操作系统，按照以下步骤配置 MCP：

<details>
<summary><b>Windows 配置</b> (点击展开)</summary>

1. 在 Cursor 中，打开或创建 MCP 配置文件：`C:\\Users\\你的用户名\\.cursor\\mcp.json`
   - 注意：请将 `你的用户名` 替换为你的 Windows 用户名

2. 添加或修改配置如下：

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "pythonw",
      "args": [
        "C:/Users/你的用户名/mcp-ssh/bridging_ssh_mcp.py"
      ]
    }
  }
}
```

> ⚠️ **请注意**:
> - 将 `你的用户名` 替换为你的 Windows 用户名
> - 确保路径正确指向你克隆或解压的项目目录
> - 路径应该反映你将项目文件放置的实际位置
> - **不要删除克隆或解压的文件夹**，这会导致 MCP 无法正常工作
</details>

<details>
<summary><b>macOS 配置</b> (点击展开)</summary>

1. 在 Cursor 中，打开或创建 MCP 配置文件：`/Users/你的用户名/.cursor/mcp.json`
   - 注意：请将 `你的用户名` 替换为你的 macOS 用户名

2. 添加或修改配置如下：

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "python3",
      "args": [
        "/Users/你的用户名/mcp-ssh/bridging_ssh_mcp.py"
      ]
    }
  }
}
```

> ⚠️ **请注意**:
> - 将 `你的用户名` 替换为你的 macOS 用户名
> - 确保路径正确指向你克隆或解压的项目目录
> - 路径应该反映你将项目文件放置的实际位置
> - **不要删除克隆或解压的文件夹**，这会导致 MCP 无法正常工作
</details>

<details>
<summary><b>Linux 配置</b> (点击展开)</summary>

1. 在 Cursor 中，打开或创建 MCP 配置文件：`/home/你的用户名/.cursor/mcp.json`
   - 注意：请将 `你的用户名` 替换为你的 Linux 用户名

2. 添加或修改配置如下：

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "python3",
      "args": [
        "/home/你的用户名/mcp-ssh/bridging_ssh_mcp.py"
      ]
    }
  }
}
```

> ⚠️ **请注意**:
> - 将 `你的用户名` 替换为你的 Linux 用户名
> - 确保路径正确指向你克隆或解压的项目目录
> - 路径应该反映你将项目文件放置的实际位置
> - **不要删除克隆或解压的文件夹**，这会导致 MCP 无法正常工作
</details>

### 4. 启动服务

配置好之后，重启 Cursor 编辑器，它会自动启动 MCP 服务。然后你就可以开始使用了。

### 5. 配置 SSH 连接

<details>
<summary><b>如何配置 SSH 连接</b> (点击展开)</summary>

1. 在 Cursor 编辑器中，使用 AI 助手创建新的 SSH 连接：
   ```
   请帮我创建一个新的 SSH 连接，连接到我的服务器
   ```

2. AI 助手会引导你提供以下信息：
   - 主机地址（IP 或域名）
   - 端口号（默认 22）
   - 用户名
   - 认证方式（密码或密钥）
   - 其他可选配置（超时时间、密钥路径等）

3. 连接创建后，你可以通过以下命令测试连接：
   ```
   请帮我测试刚才创建的 SSH 连接
   ```
</details>

## 使用示例

<details>
<summary><b>基本命令执行</b> (点击展开)</summary>

```
请在服务器上执行 ls -la 命令
```

AI 助手会：
1. 检查现有 SSH 连接
2. 执行命令并返回结果
3. 格式化输出以提高可读性
</details>

<details>
<summary><b>tmux 会话管理</b> (点击展开)</summary>

```
请创建一个新的 tmux 会话并运行 top 命令
```

AI 助手会：
1. 创建新的 tmux 会话
2. 在会话中执行 top 命令
3. 返回会话 ID 供后续使用
</details>

<details>
<summary><b>文件操作</b> (点击展开)</summary>

```
请帮我查看 /var/log/syslog 文件的最后 100 行
```

AI 助手会：
1. 检查文件权限
2. 使用适当的命令读取文件
3. 格式化并返回内容
</details>

## 高级功能

### 阻塞检测

SSH MCP 工具内置了智能的阻塞检测机制：

- 自动检测交互式程序（如 vim、nano）
- 识别后台运行的阻塞进程
- 支持设置等待超时时间（最长10分钟）
- 提供强制执行选项（使用 force 参数）

### 复合命令处理

支持执行包含 `&&` 和 `;` 的复合命令：

- 智能拆分和执行多个命令
- 保持命令执行顺序
- 提供详细的执行状态
- 支持错误处理和回滚

### tmux 集成

完整的 tmux 会话管理支持：

- 创建和管理持久化会话
- 支持发送按键序列
- 实时捕获会话输出
- 智能处理会话状态

## 增强提示设置

为了更好地使用 SSH MCP 工具与远程服务器协作，建议在 Cursor 中添加以下 CursorRules 设置：

<details>
<summary><b>推荐的 CursorRules 设置</b> (点击展开)</summary>

```
在**需要、或可能需要用户协助的**ssh任务时，可创建tmux，一个可共享的终端会话，并直接**告诉用户**可以通过什么命令链接到tmux来和你协作（不要在mcp内告诉用户，你应该输出出来）。然后再开始你的任务。

**你必须在tmux内进行任务。可以使用tmux send-keys相关命令，mcp会自动返回当前运行的命令和上一个运行的命令的结果。**

你应该先查看现有的tmux窗口再做决定。

**注意：在命令运行时必须耐心等待（sleep命令）当前命令，不要/同时/后台/继续执行下一个任务/命令。**

在用户没有明确要求时，你不应该创建帮助文件或者指南/报告文件。尤其是用户在找你帮忙的时候，你应该直接说出来。
```

</details>

添加此设置后，AI 助手将能够更智能地处理 SSH 任务，特别是在需要用户协作的场景中，可以创建共享的 tmux 会话，让远程操作更加高效和透明。

## 工作原理

<details>
<summary>技术实现细节 (点击展开)</summary>

本工具基于 **MCP (Model Context Protocol)** 标准实现，作为 AI 模型与 SSH 服务之间的桥梁。它使用 **node-ssh** 作为底层 SSH 客户端，并通过 **Zod** 进行请求验证和类型检查。

主要技术组件包括：
- **SSH 客户端**：负责建立和维护 SSH 连接，支持密码和密钥认证
- **tmux 管理器**：处理 tmux 会话的创建、管理和交互
- **命令执行系统**：支持单命令、复合命令的执行，并提供阻塞检测
- **进程监控**：实时检测进程状态，避免会话卡死
- **文件传输**：支持上传和下载功能，处理各种文件类型

每个 SSH 操作都被封装为标准化的 MCP 工具，接收结构化参数并返回格式化结果。所有远程命令都经过处理，以确保以人类可读的格式呈现，使 AI 模型能够轻松理解命令执行结果。
</details>

## 贡献指南

欢迎提交 Issue 和 Pull Request！在提交之前，请：

1. 查看现有的 Issue 和 PR
2. 遵循项目的代码风格
3. 添加适当的测试用例
4. 更新相关文档

## 许可证

本项目采用 ISC 许可证 - 详见 [LICENSE](LICENSE) 文件

---

If this project helps you, please give it a Star ⭐️ (｡♥‿♥｡) 

## 使用 Docker 运行 (推荐)

您也可以在 Docker 容器中运行此工具。这是推荐的使用方式，因为它可以避免与您的本地环境产生任何潜在的冲突。

1.  **构建 Docker 镜像:**

    ```bash
    docker build -t mcp-ssh .
    ```

2.  **运行 Docker 容器 (附带数据持久化):**

    为了确保您的连接配置和凭证在容器重启后不丢失，我们强烈建议您使用 Docker 数据卷 (Volume)。

    ```bash
    # (首次运行前) 创建一个数据卷来存储数据
    docker volume create mcp-ssh-data

    # 运行容器，并将数据卷挂载到容器的 /root/.mcp-ssh 目录
    # 同时，我们仍然建议挂载您本地的 .ssh 目录以使用现有密钥
    docker run -it -v mcp-ssh-data:/root/.mcp-ssh -v ~/.ssh:/root/.ssh mcp-ssh
    ```

    在 Windows 上，请使用 `%USERPROFILE%\.ssh` 代替 `~/.ssh`:

    ```bash
    docker run -it -v mcp-ssh-data:/root/.mcp-ssh -v %USERPROFILE%\.ssh:/root/.ssh mcp-ssh
    ``` 
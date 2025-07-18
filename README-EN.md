# SSH MCP Tool

[![ISC License](https://img.shields.io/badge/License-ISC-718096?style=flat-square)](https://opensource.org/licenses/ISC)
[![Node.js](https://img.shields.io/badge/Node.js-18.x-339933?style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![SSH](https://img.shields.io/badge/SSH-MCP-0078d7?style=flat-square)](https://github.com/shuakami/mcp-ssh)

[中文版本 (README.md)](README.md)

## What is this?

This is an SSH tool based on MCP (Model Context Protocol) that allows AI models to access and manage SSH connections through a standardized interface.

In simple terms, it enables AI assistants to perform various SSH operations, such as connecting to servers, executing commands, and managing files, without requiring users to manually input complex commands or switch to a terminal.

<details>
<summary><b>Supported Features</b> (click to expand)</summary>

- **Connection Management**: Create, get, list, update, and delete SSH connections
- **Command Execution**: Execute single commands, compound commands, and background tasks
- **tmux Session Management**: Create, get, list, send keys, and capture output
- **File Operations**: Upload, download, and view file contents
- **Process Management**: Detect blocking processes, smart waiting, and timeout handling
- **Security Control**: Password/key authentication, timeout control, and error handling
</details>

<details>
<summary><b>Key Features</b> (click to expand)</summary>

Here are some core features of the SSH MCP tool:

- **Smart Command Execution**: Automatically detects and waits for blocking processes to prevent session freezes
- **tmux Integration**: Full support for tmux session management, enabling persistent terminal sessions
- **Compound Command Support**: Intelligent handling of commands containing `&&` and `;`
- **Real-time Feedback**: Command execution status updates in real-time, supporting long-running tasks
- **Error Recovery**: Automatic handling of disconnections, timeouts, and other exceptions
- **Secure and Reliable**: Supports multiple authentication methods and protects sensitive information

Through simple natural language instructions, AI can help you complete all of the above operations without manually writing complex SSH commands or operating in the terminal.
</details>

## Quick Start

### 0. Environment Setup

<details>
<summary>Requirements (click to expand)</summary>

1. **Python 3.11+ (Required)**
   - Visit [Python's website](https://www.python.org/downloads/)
   - Download and install Python 3.11 or higher
   - **Important**: Check "Add Python to PATH" during installation
   - **Restart your computer** after installation to ensure environment variables take effect

2. **Node.js and npm**
   - Visit [Node.js website](https://nodejs.org/)
   - Download and install the LTS (Long Term Support) version
   - Use default options during installation, which will install both Node.js and npm

3. **Git**
   - Visit [Git's website](https://git-scm.com/)
   - Download and install Git
   - Use default options during installation
   
4. **tmux** (Required on remote servers)
   - Install tmux on your remote server
   - For Ubuntu/Debian: `sudo apt-get install tmux`
   - For CentOS/RHEL: `sudo yum install tmux`
</details>

### 1. Clone and Install

```bash
git clone https://github.com/shuakami/mcp-ssh.git
cd mcp-ssh
npm install
npm run build
```
> ⚠️ **Important Note**: Do not delete the cloned or extracted files after installation, as the plugin needs continuous access to these files!

### 2. Build the Project

```bash
npm run build
```

### 3. Add to Cursor MCP Configuration

Follow these steps to configure MCP based on your operating system:

<details>
<summary><b>Windows Configuration</b> (click to expand)</summary>

1. In Cursor, open or create the MCP configuration file: `C:\\Users\\YourUsername\\.cursor\\mcp.json`
   - Note: Replace `YourUsername` with your Windows username

2. Add or modify the configuration as follows:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "pythonw",
      "args": [
        "C:/Users/YourUsername/mcp-ssh/bridging_ssh_mcp.py"
      ]
    }
  }
}
```

> ⚠️ **Please note**:
> - Replace `YourUsername` with your Windows username
> - Make sure the path correctly points to your cloned or extracted project directory
> - The path should reflect where you actually placed the project files
> - **Do not delete the cloned or extracted folder**, as this will cause MCP to stop working
</details>

<details>
<summary><b>macOS Configuration</b> (click to expand)</summary>

1. In Cursor, open or create the MCP configuration file: `/Users/YourUsername/.cursor/mcp.json`
   - Note: Replace `YourUsername` with your macOS username

2. Add or modify the configuration as follows:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "python3",
      "args": [
        "/Users/YourUsername/mcp-ssh/bridging_ssh_mcp.py"
      ]
    }
  }
}
```

> ⚠️ **Please note**:
> - Replace `YourUsername` with your macOS username
> - Make sure the path correctly points to your cloned or extracted project directory
> - The path should reflect where you actually placed the project files
> - **Do not delete the cloned or extracted folder**, as this will cause MCP to stop working
</details>

<details>
<summary><b>Linux Configuration</b> (click to expand)</summary>

1. In Cursor, open or create the MCP configuration file: `/home/YourUsername/.cursor/mcp.json`
   - Note: Replace `YourUsername` with your Linux username

2. Add or modify the configuration as follows:

```json
{
  "mcpServers": {
    "ssh-mcp": {
      "command": "python3",
      "args": [
        "/home/YourUsername/mcp-ssh/bridging_ssh_mcp.py"
      ]
    }
  }
}
```

> ⚠️ **Please note**:
> - Replace `YourUsername` with your Linux username
> - Make sure the path correctly points to your cloned or extracted project directory
> - The path should reflect where you actually placed the project files
> - **Do not delete the cloned or extracted folder**, as this will cause MCP to stop working
</details>

### 4. Start the Service

After configuration, restart the Cursor editor, and it will automatically start the MCP service. You can then begin using it.

### 5. Configure SSH Connection

<details>
<summary><b>How to Configure SSH Connection</b> (click to expand)</summary>

1. In the Cursor editor, use the AI assistant to create a new SSH connection:
   ```
   Please help me create a new SSH connection to my server
   ```

2. The AI assistant will guide you to provide the following information:
   - Host address (IP or domain name)
   - Port number (default 22)
   - Username
   - Authentication method (password or key)
   - Other optional configurations (timeout, key path, etc.)

3. After the connection is created, you can test it with:
   ```
   Please help me test the SSH connection we just created
   ```
</details>

## Usage Examples

<details>
<summary><b>Basic Command Execution</b> (click to expand)</summary>

```
Please execute the ls -la command on the server
```

The AI assistant will:
1. Check existing SSH connections
2. Execute the command and return results
3. Format output for better readability
</details>

<details>
<summary><b>tmux Session Management</b> (click to expand)</summary>

```
Please create a new tmux session and run the top command
```

The AI assistant will:
1. Create a new tmux session
2. Execute the top command in the session
3. Return the session ID for future use
</details>

<details>
<summary><b>File Operations</b> (click to expand)</summary>

```
Please help me view the last 100 lines of /var/log/syslog
```

The AI assistant will:
1. Check file permissions
2. Use appropriate commands to read the file
3. Format and return the content
</details>

## Advanced Features

### Blocking Detection

SSH MCP tool includes intelligent blocking detection mechanisms:

- Automatic detection of interactive programs (like vim, nano)
- Identification of blocking background processes
- Configurable wait timeout (up to 10 minutes)
- Force execution option (using the force parameter)

### Compound Command Processing

Support for executing commands containing `&&` and `;`:

- Smart splitting and execution of multiple commands
- Maintains command execution order
- Provides detailed execution status
- Supports error handling and rollback

### tmux Integration

Complete tmux session management support:

- Create and manage persistent sessions
- Support for sending keystrokes
- Real-time session output capture
- Intelligent session state handling

## Enhanced Prompt Settings

To better use the SSH MCP tool for remote server collaboration, we recommend adding the following CursorRules setting to Cursor:

<details>
<summary><b>Recommended CursorRules Setting</b> (click to expand)</summary>

```
When handling SSH tasks that **need or might need user assistance**, create a tmux session (a shareable terminal session) and **directly tell the user** what command they can use to connect to the tmux session to collaborate with you (output this directly, not within MCP). Then begin your task.

**You must perform tasks within tmux. You can use tmux send-keys related commands, and MCP will automatically return the currently running command and the result of the previous command.**

You should check existing tmux windows before making a decision.

**Note: When running commands, you must patiently wait (using sleep commands) for the current command to complete, and not run the next task/command simultaneously/in the background/continuing.**

Unless explicitly requested by the user, you should not create help files, guides, or report files. Especially when the user is asking for your help, you should directly say what you need.
```

</details>

With this setting, the AI assistant will be able to handle SSH tasks more intelligently, especially in scenarios requiring user collaboration, by creating shared tmux sessions for more efficient and transparent remote operations.

## How It Works

<details>
<summary>Technical Implementation Details (click to expand)</summary>

This tool is based on the **MCP (Model Context Protocol)** standard, serving as a bridge between AI models and SSH services. It uses **node-ssh** as the underlying SSH client and **Zod** for request validation and type checking.

Main technical components include:
- **SSH Client**: Responsible for establishing and maintaining SSH connections, supporting password and key authentication
- **tmux Manager**: Handles the creation, management, and interaction with tmux sessions
- **Command Execution System**: Supports execution of single commands, compound commands, and provides blocking detection
- **Process Monitoring**: Real-time detection of process states to prevent session deadlocks
- **File Transfer**: Supports upload and download functionality, handling various file types

Each SSH operation is encapsulated as a standardized MCP tool, receiving structured parameters and returning formatted results. All remote commands are processed to ensure they are presented in a human-readable format, making it easy for AI models to understand command execution results.
</details>

## Contributing

Issues and Pull Requests are welcome! Before submitting, please:

1. Check existing Issues and PRs
2. Follow the project's code style
3. Add appropriate test cases
4. Update relevant documentation

## License

This project is licensed under the ISC License - see the [LICENSE](LICENSE) file for details

---

If this project helps you, please give it a Star ⭐️ (｡♥‿♥｡) 

## Running with Docker (Recommended)

You can also run this tool inside a Docker container. This is the recommended way to use it, as it avoids any potential conflicts with your local environment.

1.  **Build the Docker image:**

    ```bash
    docker build -t mcp-ssh .
    ```

2.  **Run the Docker container (with data persistence):**

    To ensure your connection configurations and credentials are not lost when the container restarts, we strongly recommend using a Docker Volume.

    ```bash
    # (Before the first run) Create a volume to store the data
    docker volume create mcp-ssh-data

    # Run the container and mount the volume to the /root/.mcp-ssh directory inside the container
    # We also still recommend mounting your local .ssh directory to use your existing keys
    docker run -it -v mcp-ssh-data:/root/.mcp-ssh -v ~/.ssh:/root/.ssh mcp-ssh
    ```

    On Windows, you should use `%USERPROFILE%\.ssh` instead of `~/.ssh`:

    ```bash
    docker run -it -v mcp-ssh-data:/root/.mcp-ssh -v %USERPROFILE%\.ssh:/root/.ssh mcp-ssh
    ``` 
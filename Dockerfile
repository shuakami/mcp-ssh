FROM node:18-alpine

# 安装 Python 和其他构建工具
RUN apk add --no-cache python3 py3-pip git

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装所有依赖以进行构建
RUN npm install

# 设置镜像源
RUN npm config set registry https://registry.npmmirror.com

# 复制项目文件
COPY . .

# 编译 TypeScript
RUN npm run build

# 卸载开发依赖，只保留生产依赖
RUN npm prune --production

# 设置环境变量，告知应用在 Docker 中运行
ENV IS_DOCKER=true

# 运行启动脚本
CMD ["python3", "bridging_ssh_mcp.py"] 
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * 主机密钥校验（known_hosts / TOFU）
 *
 * 此前 SSHService 从不给 ssh2 传 hostVerifier。ssh2 在这种情况下的行为是
 * 无条件接受任何主机密钥（见 ssh2/lib/protocol/kex.js:1194，
 * "Host accepted by default (no verification)"），既没有 TOFU 记录，
 * 密钥变更也不告警。中间人只要接管握手，就能拿到明文密码。
 *
 * 这里实现 OpenSSH 的 accept-new 语义：
 *   - 已知主机且密钥一致 → 静默通过
 *   - 未知主机           → 记录并放行（返回 isNew，由调用方在结果里告知用户）
 *   - 已知主机但密钥不符 → 拒绝连接
 *
 * 选择 accept-new 而非默认的 ask，是因为 MCP 场景下没有可同步询问的人；
 * 而真正危险的「密钥变了」这一情形仍然是硬失败。
 */

export type HostKeyVerdict =
  | { ok: true; isNew: boolean; fingerprint: string }
  | { ok: false; reason: 'mismatch' | 'malformed'; fingerprint: string; knownFingerprint: string };

// known_hosts 路径，可用环境变量覆盖（便于容器与测试）
function knownHostsPath(): string {
  return process.env.SSH_KNOWN_HOSTS || path.join(os.homedir(), '.ssh', 'known_hosts');
}

/** OpenSSH 风格指纹：SHA256:<base64，去掉结尾的 => */
export function fingerprintOf(key: Buffer): string {
  const hash = crypto.createHash('sha256').update(key).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

/**
 * 从主机公钥的原始字节中解出密钥类型。
 *
 * SSH 线格式：4 字节大端长度 + 该长度的类型字符串（如 "ssh-ed25519"），
 * 之后才是密钥本体。known_hosts 的第二列用的正是这个类型字符串。
 */
export function keyTypeOf(key: Buffer): string | null {
  if (key.length < 4) return null;

  const len = key.readUInt32BE(0);
  // 合法的类型字符串很短；加上界防止畸形输入导致越界读取
  if (len <= 0 || len > 64 || key.length < 4 + len) return null;

  const type = key.subarray(4, 4 + len).toString('ascii');
  // 只接受可打印的 ASCII 标识符，避免把二进制垃圾写进 known_hosts
  return /^[\x21-\x7e]+$/.test(type) ? type : null;
}

/**
 * known_hosts 的 host 字段格式化。
 * OpenSSH 对非 22 端口写作 [host]:port，这里保持一致，
 * 以便与用户已有的 known_hosts 互认。
 */
function hostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** 匹配 |1|salt|hash 形式的散列条目 */
function hashedHostMatches(token: string, field: string): boolean {
  const parts = field.split('|');
  // 形如 ['', '1', '<salt-b64>', '<hash-b64>']
  if (parts.length !== 4 || parts[1] !== '1') return false;

  try {
    const salt = Buffer.from(parts[2], 'base64');
    const expected = parts[3];
    const actual = crypto.createHmac('sha1', salt).update(token).digest('base64');
    return actual === expected;
  } catch {
    return false;
  }
}

/** 某一行的 host 字段是否匹配目标（支持逗号分隔的多主机与散列条目） */
function lineMatchesHost(hostField: string, token: string): boolean {
  for (const entry of hostField.split(',')) {
    if (entry === token) return true;
    if (entry.startsWith('|1|') && hashedHostMatches(token, entry)) return true;
  }
  return false;
}

/**
 * 校验主机密钥。
 *
 * @param host    目标主机
 * @param port    目标端口
 * @param key     主机公钥原始字节（密钥类型从中解析）
 */
export function verifyHostKey(
  host: string,
  port: number,
  key: Buffer
): HostKeyVerdict {
  const fingerprint = fingerprintOf(key);
  const token = hostToken(host, port);
  const filePath = knownHostsPath();

  const keyType = keyTypeOf(key);
  if (!keyType) {
    // 解不出类型说明这不是一个正常的 SSH 公钥，拒绝比放行安全
    return { ok: false, reason: 'malformed', fingerprint, knownFingerprint: '(无)' };
  }

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // 文件不存在或不可读：视为全新主机，走 TOFU 记录
    recordHostKey(host, port, keyType, key);
    return { ok: true, isNew: true, fingerprint };
  }

  const keyB64 = key.toString('base64');

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    // 跳过空行、注释、以及 @revoked / @cert-authority 这类带标记的行
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;

    const [hostField, lineType, lineKey] = line.split(/\s+/);
    if (!hostField || !lineType || !lineKey) continue;
    if (!lineMatchesHost(hostField, token)) continue;

    // 同一主机可能登记多种密钥类型（ed25519 / rsa / ecdsa）。
    // 只有类型相同的那条才具备可比性，类型不同应继续找，
    // 否则会把「换了协商算法」误判成「密钥被换了」。
    if (lineType !== keyType) continue;

    if (lineKey === keyB64) {
      return { ok: true, isNew: false, fingerprint };
    }

    // 类型相同但密钥不同 —— 这正是需要硬失败的情形
    let knownFingerprint = '(无法解析)';
    try {
      knownFingerprint = fingerprintOf(Buffer.from(lineKey, 'base64'));
    } catch {
      // 保持占位符
    }
    return { ok: false, reason: 'mismatch', fingerprint, knownFingerprint };
  }

  // 该主机（或该密钥类型）尚未登记 → TOFU
  recordHostKey(host, port, keyType, key);
  return { ok: true, isNew: true, fingerprint };
}

/** 追加一条 known_hosts 记录 */
function recordHostKey(host: string, port: number, keyType: string, key: Buffer): void {
  const filePath = knownHostsPath();
  const line = `${hostToken(host, port)} ${keyType} ${key.toString('base64')}\n`;

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      // .ssh 目录必须是 0700，否则 OpenSSH 自己会拒绝使用
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.appendFileSync(filePath, line, { mode: 0o600 });
  } catch (error) {
    // 记录失败不阻断连接，但要让用户看见——否则每次连接都会被当成新主机
    console.error(`写入 known_hosts 失败（${filePath}）:`, error);
  }
}

/** 校验失败时给调用方的说明文本 */
export function rejectionMessage(
  host: string,
  port: number,
  verdict: Extract<HostKeyVerdict, { ok: false }>
): string {
  if (verdict.reason === 'malformed') {
    return (
      `主机密钥校验失败：${hostToken(host, port)} 返回的公钥格式无法解析。\n` +
      `  指纹: ${verdict.fingerprint}\n` +
      `连接已中止。`
    );
  }

  return (
    `主机密钥校验失败：${hostToken(host, port)} 的密钥与 known_hosts 中记录的不一致。\n` +
    `  记录的指纹: ${verdict.knownFingerprint}\n` +
    `  本次的指纹: ${verdict.fingerprint}\n\n` +
    `这可能意味着中间人攻击，也可能只是服务器重装或更换了密钥。\n` +
    `确认属于后者时，删除 ${knownHostsPath()} 中对应 ${hostToken(host, port)} 的那一行再重连。`
  );
}

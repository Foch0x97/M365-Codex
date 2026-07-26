/** 全项目共用的常量。 */

/** 对外 API Key 前缀，与 OpenAI 客户端习惯保持一致。 */
export const API_KEY_PREFIX = 'sk-';

/** API Key 随机主体长度（Base62 字符数），要求 ≥ 48。 */
export const API_KEY_BODY_LENGTH = 52;

/** 用于数据库索引的前缀片段长度：`sk-` + 8 位随机字符。 */
export const API_KEY_LOOKUP_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

/** 主加密密钥解码后要求的字节数（AES-256）。 */
export const MASTER_KEY_BYTES = 32;

/** 默认监听端口。 */
export const DEFAULT_PORT = 8080;

/** 默认数据目录。 */
export const DEFAULT_DATA_DIR = '/data';

/** 管理会话默认有效期：12 小时。 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 请求 ID 响应头。 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Codex 唯一支持的线协议（`chat` 已于 2026-02 移除）。 */
export const CODEX_WIRE_API = 'responses';

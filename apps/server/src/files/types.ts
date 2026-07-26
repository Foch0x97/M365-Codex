/**
 * 文件子系统的领域类型（对应实施计划 §11、§M6）。
 */

/** 内容类别：决定走哪条文本提取路径，以及是否可作为图片输入。 */
export const FILE_KINDS = ['text', 'pdf', 'docx', 'xlsx', 'pptx', 'image', 'unknown'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** 文件行的处理状态。unsupported_feature（如 PDF 提取因审计不过关而禁用）单独归为 error 并写明原因。 */
export const FILE_STATUSES = ['processed', 'error'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const UPLOAD_STATUSES = ['pending', 'completed', 'cancelled', 'expired'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** 提取结果：成功给出文本；明确跳过（如图片/未识别二进制）给出原因；失败给出错误原因。 */
export interface ExtractionResult {
  /** 是否产出了可用文本 */
  ok: boolean;
  text: string | null;
  /** 未产出文本时的说明（跳过原因或失败原因），供 files 表 extraction_note 使用 */
  note: string | null;
  /**
   * ok=false 时区分两种情况：true=明确不提取（策略性跳过，如图片/未识别二进制/
   * 不可信），不算错误；false=本该能提取却失败了（如 PDF/Office 文档解析出错、
   * 声称是文本但内容不是合法 UTF-8）。files 表据此决定 status 是 processed 还是 error。
   */
  skipped: boolean;
}

/** 对外的 File 对象（对齐 OpenAI Files API 字段命名）。 */
export interface FileObject {
  id: string;
  object: 'file';
  bytes: number;
  /** 秒级 epoch，与 OpenAI 对齐 */
  created_at: number;
  filename: string;
  purpose: string;
  status: FileStatus;
  status_details: string | null;
  /** 秒级 epoch；null 表示不自动过期 */
  expires_at: number | null;
}

/** 对外的 Upload.Part 对象。 */
export interface UploadPartObject {
  id: string;
  object: 'upload.part';
  created_at: number;
  upload_id: string;
}

/** 对外的 Upload 对象。 */
export interface UploadObject {
  id: string;
  object: 'upload';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  status: UploadStatus;
  expires_at: number;
  file: FileObject | null;
}

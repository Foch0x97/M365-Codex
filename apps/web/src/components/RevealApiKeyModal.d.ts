/**
 * API Key 创建后明文只会出现这一次——服务端不保存明文，之后任何接口都拿不到它。
 * 关闭前必须勾选「我已保存」，避免用户手滑关掉弹窗后再也找不回这个密钥。
 */
export declare function RevealApiKeyModal({ apiKey, onClose }: {
    apiKey: string;
    onClose: () => void;
}): import("react").JSX.Element;

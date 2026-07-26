/** 复制到剪贴板；复制成功后短暂显示对勾反馈。剪贴板 API 不可用时静默失败，不抛错打断页面。 */
export declare function CopyButton({ value, label }: {
    value: string;
    label?: string;
}): import("react").JSX.Element;

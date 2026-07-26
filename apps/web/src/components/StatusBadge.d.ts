/** 各种状态 → 中文标签 + 颜色，集中一处维护，避免每个页面各写一套映射。 */
export declare function AccountStatusBadge({ status }: {
    status: string;
}): import("react").JSX.Element;
export declare function SystemStatusBadge({ status }: {
    status: string;
}): import("react").JSX.Element;
export declare function ResponseStatusBadge({ status }: {
    status: string;
}): import("react").JSX.Element;
export declare function ProxyStatusBadge({ status }: {
    status: string;
}): import("react").JSX.Element;
export declare function CapabilityStatusBadge({ status }: {
    status: string;
}): import("react").JSX.Element;
export declare function BoolBadge({ value, trueLabel, falseLabel }: {
    value: boolean;
    trueLabel: string;
    falseLabel: string;
}): import("react").JSX.Element;

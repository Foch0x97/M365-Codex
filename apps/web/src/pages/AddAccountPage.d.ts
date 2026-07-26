/**
 * 添加账号只有一种方式：本网关自己的 PKCE 授权流程。
 * 因为回调落在 Microsoft 自己的页面上，本服务不需要公网可达，也不用暴露回调端点——
 * 用户在浏览器完成登录后，把地址栏的完整 URL 贴回来即可。
 */
export declare function AddAccountPage(): import("react").JSX.Element;

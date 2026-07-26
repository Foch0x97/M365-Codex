import { type ReactNode } from 'react';
interface AuthContextValue {
    token: string | null;
    expiresAt: number | null;
    status: 'checking' | 'authenticated' | 'anonymous';
    login: (password: string) => Promise<void>;
    logout: () => void;
}
export declare function AuthProvider({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useAuth(): AuthContextValue;
export {};

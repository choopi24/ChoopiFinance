import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { api } from "../lib/api";

export interface AuthUser {
  id: number;
  username: string;
  display_currency: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Auth responses aren't wrapped in the { success, data } envelope, so we call the
// raw paths through the shared api client (which handles connection failures and
// surfaces a friendly "can't reach the server" instead of a JSON-parse crash).
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  useEffect(() => {
    api.get<{ user: AuthUser }>("/auth/me")
      .then(({ user }) => setState({ user, loading: false }))
      .catch(() => setState({ user: null, loading: false }));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.post<{ user: AuthUser }>("/auth/login", { username, password });
    setState({ user, loading: false });
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const { user } = await api.post<{ user: AuthUser }>("/auth/register", { username, password });
    setState({ user, loading: false });
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout", {});
    setState({ user: null, loading: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

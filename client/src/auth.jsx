import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, setCsrf } from "./api";
import { connect, disconnect } from "./socket";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/auth/me")
      .then((d) => {
        setCsrf(d.csrf);
        setUser(d.user);
        connect();
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const d = await api("/api/auth/login", { method: "POST", body: { email, password } });
    setCsrf(d.csrf);
    setUser(d.user);
    connect();
    return d.user;
  }, []);

  const register = useCallback(async (name, email, password) => {
    const d = await api("/api/auth/register", { method: "POST", body: { name, email, password } });
    setCsrf(d.csrf);
    setUser(d.user);
    connect();
    return d.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setCsrf(null);
    setUser(null);
    disconnect();
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

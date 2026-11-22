import React, { createContext, useContext, useState, useEffect } from 'react';
import { AuthUser, getStoredUser, setStoredUser, setStoredToken } from '../api/client';

interface AuthContextType {
  user: AuthUser | null;
  login: (user: AuthUser, token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(getStoredUser());

  const login = (u: AuthUser, token: string) => {
    setStoredUser(u);
    setStoredToken(token);
    setUser(u);
  };

  const logout = () => {
    setStoredUser(null);
    setStoredToken(null);
    setUser(null);
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

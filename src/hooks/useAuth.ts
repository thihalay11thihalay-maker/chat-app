import { useCallback, useState, useEffect } from 'react';
import { User } from '../types';
import { getCurrentUser, registerUser as registerUserApi, loginUser as loginUserApi, logoutUser as logoutUserApi } from '../lib/auth';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const currentUser = getCurrentUser();
    setUser(currentUser);
    setLoading(false);
  }, []);

  const register = useCallback(async (email: string, password: string, name: string): Promise<User | null> => {
    try {
      setError(null);
      const newUser = await registerUserApi(email, password, name);
      setUser(newUser);
      return newUser;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      setError(message);
      return null;
    }
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<User | null> => {
    try {
      setError(null);
      const loggedUser = await loginUserApi(email, password);
      setUser(loggedUser);
      return loggedUser;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      return null;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      setError(null);
      await logoutUserApi();
      setUser(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Logout failed';
      setError(message);
    }
  }, []);

  return { user, loading, error, register, login, logout, isAuthenticated: !!user };
}

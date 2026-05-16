import { useState, FormEvent, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Network, Eye, EyeOff, AlertCircle, ShieldCheck } from 'lucide-react';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import CircuitBackground from '../components/CircuitBackground';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const totpInputRef = useRef<HTMLInputElement>(null);

  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();
  const { theme, toggleTheme } = useThemeStore();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (totpToken) {
      // Step 2: verify TOTP code
      if (totpCode.replace(/\s/g, '').length !== 6) return;
      setLoading(true);
      setError('');
      try {
        const { data } = await authApi.totpVerify(totpToken, totpCode);
        setAuth(data.token, data.user!);
        navigate('/dashboard');
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setError(msg || 'Invalid code. Please try again.');
        setTotpCode('');
        setTimeout(() => totpInputRef.current?.focus(), 50);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Step 1: username + password
    if (!username || !password) return;
    setLoading(true);
    setError('');
    try {
      const { data } = await authApi.login(username, password);
      if (data.requires_totp && data.totp_token) {
        setTotpToken(data.totp_token);
        setTimeout(() => totpInputRef.current?.focus(), 50);
      } else {
        setAuth(data.token!, data.user!);
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const isDark = theme === 'dark';

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden"
      style={{ backgroundColor: isDark ? '#040c07' : '#e8f2f7' }}
    >
      <CircuitBackground theme={theme} />

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className={`absolute top-4 right-4 p-2 rounded-lg transition-colors z-10 ${
          isDark
            ? 'text-slate-400 hover:text-slate-200'
            : 'text-slate-500 hover:text-slate-800'
        }`}
      >
        {isDark ? '☀️' : '🌙'}
      </button>

      <div className="w-full max-w-sm relative z-10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className={`w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mb-4 ${
            isDark ? 'shadow-lg shadow-blue-900/50' : 'shadow-lg shadow-blue-400/40'
          }`}>
            <Network className="w-7 h-7 text-white" />
          </div>
          <h1 className={`text-2xl font-bold drop-shadow-lg ${isDark ? 'text-white' : 'text-slate-800'}`}>
            Mikrotik Manager
          </h1>
          <p className={`text-sm mt-1 ${isDark ? 'text-green-400/70' : 'text-cyan-700/80'}`}>
            Network Management Platform
          </p>
        </div>

        {/* Login card */}
        <div className={`backdrop-blur-sm rounded-xl shadow-2xl p-6 ${
          isDark
            ? 'bg-slate-900/80 border border-slate-700/60 shadow-black/60'
            : 'bg-white/75 border border-slate-300/60 shadow-slate-400/30'
        }`}>
          <h2 className={`text-lg font-semibold mb-6 ${isDark ? 'text-white' : 'text-slate-800'}`}>
            Sign in to your account
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {totpToken ? (
              /* Step 2: TOTP code */
              <div>
                <div className={`flex items-center gap-2 mb-4 p-3 rounded-lg ${isDark ? 'bg-blue-900/30 border border-blue-700/50' : 'bg-blue-50 border border-blue-200'}`}>
                  <ShieldCheck className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-blue-400' : 'text-blue-500'}`} />
                  <p className={`text-sm ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                    Enter the 6-digit code from your authenticator app.
                  </p>
                </div>
                <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`} htmlFor="totp-code">
                  Authenticator Code
                </label>
                <input
                  id="totp-code"
                  ref={totpInputRef}
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  className={`w-full px-3 py-2 rounded-lg text-center text-xl tracking-[0.4em] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors ${
                    isDark
                      ? 'bg-slate-800/80 border border-slate-600 text-white placeholder-slate-500'
                      : 'bg-white/80 border border-slate-300 text-slate-800 placeholder-slate-400'
                  }`}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  autoComplete="one-time-code"
                />
                <button
                  type="button"
                  onClick={() => { setTotpToken(null); setTotpCode(''); setError(''); }}
                  className={`mt-2 text-sm ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Back to login
                </button>
              </div>
            ) : (
              /* Step 1: username + password */
              <>
                <div>
                  <label
                    className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                    htmlFor="username"
                  >
                    Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    className={`w-full px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${
                      isDark
                        ? 'bg-slate-800/80 border border-slate-600 text-white placeholder-slate-500'
                        : 'bg-white/80 border border-slate-300 text-slate-800 placeholder-slate-400'
                    }`}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    autoComplete="username"
                    autoFocus
                  />
                </div>

                <div>
                  <label
                    className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                    htmlFor="password"
                  >
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      className={`w-full px-3 py-2 pr-10 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${
                        isDark
                          ? 'bg-slate-800/80 border border-slate-600 text-white placeholder-slate-500'
                          : 'bg-white/80 border border-slate-300 text-slate-800 placeholder-slate-400'
                      }`}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${
                        isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-400 hover:text-slate-600'
                      }`}
                      onClick={() => setShowPassword((s) => !s)}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </>
            )}

            {error && (
              <div className={`flex items-center gap-2 p-3 rounded-lg ${
                isDark
                  ? 'bg-red-900/30 border border-red-700/50'
                  : 'bg-red-50 border border-red-200'
              }`}>
                <AlertCircle className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-red-400' : 'text-red-500'}`} />
                <p className={`text-sm ${isDark ? 'text-red-300' : 'text-red-600'}`}>{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (totpToken ? totpCode.length !== 6 : !username || !password)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
            >
              {loading ? (
                <>
                  <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {totpToken ? 'Verifying...' : 'Signing in...'}
                </>
              ) : (
                totpToken ? 'Verify Code' : 'Sign in'
              )}
            </button>
          </form>
        </div>

        <p className={`text-center text-xs mt-6 ${isDark ? 'text-slate-600' : 'text-slate-500'}`}>
          Default credentials: admin / admin
        </p>
      </div>
    </div>
  );
}

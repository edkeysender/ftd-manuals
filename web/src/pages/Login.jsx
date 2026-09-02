import React, { useState } from 'react';
import { api } from '../api.js';
import { t, LanguageSwitch } from '../i18n.jsx';

/** Full-screen sign-in form shown until /api/auth/me answers with a user. */
export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api.login(email.trim(), password);
      onLogin(user);
    } catch (err) {
      setError(err.status === 401 ? t('Wrong e-mail or password') : err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">FTD</span>
          <span className="brand-name">{t('Documentation Console')}</span>
        </div>
        <h1>{t('Sign in')}</h1>
        <label>
          {t('E-mail')}
          <input type="email" autoFocus required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          {t('Password')}
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary" disabled={busy || !email || !password}>
          {busy ? t('Signing in…') : t('Sign in')}
        </button>
        <div className="login-lang">
          <LanguageSwitch />
        </div>
      </form>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { api, timeAgo } from '../api.js';
import { useAuth, useToast, ROLE_LABELS } from '../App.jsx';
import { t } from '../i18n.jsx';

/** Settings card: change your own password (current password required). */
export function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (next !== repeat) return toast(t('Passwords do not match'), 'err');
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      toast(t('Password changed'));
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card">
      <h2>{t('Your password')}</h2>
      <p>{t('Change the password you sign in with. At least 8 characters.')}</p>
      <form className="pair wrap" onSubmit={submit}>
        <input type="password" placeholder={t('Current password')} autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input type="password" placeholder={t('New password')} autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
        <input type="password" placeholder={t('Repeat new password')} autoComplete="new-password" required minLength={8} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || !current || !next || !repeat}>
          {t('Change password')}
        </button>
      </form>
    </section>
  );
}

const EMPTY = { name: '', email: '', password: '', role: 'editor' };

/** Settings card (administrators only): who can sign in, with which role. */
export function UsersCard() {
  const { user: me, isAdmin } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);

  const reload = () => api.users().then(setUsers).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin]);

  if (!isAdmin) return null;

  async function run(fn, okMsg) {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await reload();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function add(e) {
    e.preventDefault();
    await run(async () => {
      await api.createUser(form);
      setForm(EMPTY);
    }, t('User {email} added', { email: form.email }));
  }

  function resetPassword(u) {
    const password = prompt(t('New password for {email} (at least 8 characters):', { email: u.email }));
    if (password === null) return;
    run(() => api.updateUser(u.id, { password }), t('Password of {email} reset', { email: u.email }));
  }

  function remove(u) {
    if (!confirm(t('Delete user {email}?', { email: u.email }))) return;
    run(() => api.deleteUser(u.id), t('{email} deleted', { email: u.email }));
  }

  return (
    <section className="settings-card">
      <h2>{t('Users')}</h2>
      <p>
        {t('Who can sign in to the console. Administrators can also delete — manuals, drafts, assets, inbox files, comment threads and users; editors can do everything else.')}
      </p>
      {users ? (
        <table className="table users-table">
          <thead>
            <tr>
              <th>{t('Name')}</th>
              <th>{t('E-mail')}</th>
              <th>{t('Role')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.name}
                  {u.id === me.id && <span className="chip chip-you">{t('you')}</span>}
                </td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} disabled={busy || u.id === me.id} onChange={(e) => run(() => api.updateUser(u.id, { role: e.target.value }))}>
                    {Object.entries(ROLE_LABELS).map(([id, label]) => (
                      <option key={id} value={id}>
                        {t(label)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="btn-row">
                  <button className="btn btn-sm" disabled={busy} onClick={() => resetPassword(u)}>
                    {t('Reset password…')}
                  </button>
                  {u.id !== me.id && (
                    <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(u)}>
                      {t('Delete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">{t('Loading…')}</p>
      )}
      <h3 className="settings-sub">{t('Add user')}</h3>
      <form className="pair wrap" onSubmit={add}>
        <input placeholder={t('Name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input type="email" placeholder={t('E-mail')} required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input type="password" placeholder={t('Password')} autoComplete="new-password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {Object.entries(ROLE_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {t(label)}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busy || !form.email || !form.password}>
          {t('Add user')}
        </button>
      </form>
    </section>
  );
}

/** Settings card: bearer tokens for the /mcp endpoint — each user manages their own
 *  (administrators see everyone's). The token value is shown exactly once. */
export function TokensCard() {
  const toast = useToast();
  const { me } = useAuth();
  const [tokens, setTokens] = useState(null);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState(null); // {token, label} — shown once after creation
  const [busy, setBusy] = useState(false);

  const load = () => api.tokens().then(setTokens).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const tk = await api.createToken(label.trim() || undefined);
      setFresh(tk);
      setLabel('');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(tk) {
    if (!confirm(t('Revoke token "{label}"? MCP clients using it stop working immediately.', { label: tk.label }))) return;
    try {
      await api.revokeToken(tk.id);
      if (fresh && fresh.id === tk.id) setFresh(null);
      await load();
      toast(t('Token revoked'));
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  return (
    <section className="settings-card">
      <h2>{t('MCP access tokens')}</h2>
      <p>
        {t('The MCP endpoint requires a bearer token. Create one per agent or machine and send it as')}{' '}
        <code>Authorization: Bearer &lt;token&gt;</code>. {t('The value is shown only once — revoke a token to cut an agent off.')}
      </p>
      {fresh && (
        <div className="token-reveal">
          <strong>{t('Token "{label}" created — copy it now, it will not be shown again:', { label: fresh.label })}</strong>
          <div className="pair">
            <code className="token-value">{fresh.token}</code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(fresh.token);
                toast(t('Token copied'));
              }}
            >
              {t('Copy')}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setFresh(null)}>
              {t('Done')}
            </button>
          </div>
        </div>
      )}
      <form className="pair wrap" onSubmit={create}>
        <input placeholder={t('Label (which agent / machine uses it)')} value={label} onChange={(e) => setLabel(e.target.value)} style={{ minWidth: 260 }} />
        <button className="btn btn-primary" disabled={busy}>
          {busy ? t('Creating…') : t('Create token')}
        </button>
      </form>
      {tokens === null ? (
        <p className="muted">{t('Loading…')}</p>
      ) : tokens.length === 0 ? (
        <p className="muted">{t('No tokens yet — MCP clients cannot connect until one exists.')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Label')}</th>
              {me?.role === 'admin' && <th>{t('Owner')}</th>}
              <th>{t('Created')}</th>
              <th>{t('Last used')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tk) => (
              <tr key={tk.id}>
                <td><strong>{tk.label}</strong></td>
                {me?.role === 'admin' && <td className="muted">{tk.owner}</td>}
                <td className="muted">{new Date(tk.createdAt).toISOString().slice(0, 10)}</td>
                <td className="muted">{tk.lastUsedAt ? timeAgo(tk.lastUsedAt) : t('never')}</td>
                <td className="btn-row">
                  <button className="btn btn-sm btn-danger" onClick={() => revoke(tk)}>
                    {t('Revoke')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

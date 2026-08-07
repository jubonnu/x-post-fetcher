import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

export function ChangePasswordPage() {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "パスワード変更に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <div className="header-row">
        <h1>パスワード変更</h1>
        <Link to="/">一覧へ戻る</Link>
      </div>
      <div className="card" style={{ maxWidth: 380 }}>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="currentPassword">現在のパスワード</label>
            <input
              id="currentPassword"
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="field">
            <label htmlFor="newPassword">新しいパスワード（8文字以上）</label>
            <input
              id="newPassword"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          {done ? <p className="muted">パスワードを変更しました</p> : null}
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? "変更中…" : "変更する"}
          </button>
        </form>
      </div>
    </div>
  );
}

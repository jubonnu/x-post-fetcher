import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signup(email, password, inviteCode);
      navigate("/");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "登録に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <h1>CardHub 管理画面</h1>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>新規登録</h2>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="email">メールアドレス</label>
            <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label htmlFor="password">パスワード（8文字以上）</label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="field">
            <label htmlFor="inviteCode">招待コード</label>
            <input id="inviteCode" type="text" required value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
          </div>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className="primary" disabled={submitting} style={{ width: "100%" }}>
            {submitting ? "登録中…" : "登録"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 14 }}>
          既にアカウントがある場合は<Link to="/login">ログイン</Link>
        </p>
      </div>
    </div>
  );
}

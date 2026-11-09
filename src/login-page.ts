/**
 * The Garden — Login Page HTML
 * Served at /authorize during OAuth flow.
 * Simple, clean, The Garden branding.
 */

export function loginPageHtml(error?: string): string {
  const errorBlock = error
    ? `<div class="error">${escapeHtml(error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Garden — Enter</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      width: 100%;
      max-width: 360px;
      padding: 2rem;
    }
    .title {
      text-align: center;
      margin-bottom: 2rem;
    }
    .title h1 {
      font-size: 1.5rem;
      font-weight: 300;
      letter-spacing: 0.15em;
      color: #c0c0c0;
    }
    .title .emoji {
      font-size: 2rem;
      margin-bottom: 0.75rem;
      display: block;
    }
    .subtitle {
      font-size: 0.85rem;
      color: #666;
      margin-top: 0.5rem;
    }
    form { display: flex; flex-direction: column; gap: 1rem; }
    input[type="password"] {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      border-color: #555;
    }
    button {
      padding: 0.75rem;
      background: #1a3a1a;
      border: 1px solid #2a5a2a;
      border-radius: 8px;
      color: #90c090;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
    }
    button:hover {
      background: #224422;
      border-color: #3a7a3a;
    }
    .error {
      background: #3a1a1a;
      border: 1px solid #5a2a2a;
      color: #e09090;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.9rem;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="title">
      <span class="emoji">🌿</span>
      <h1>THE GARDEN</h1>
      <p class="subtitle">sovereign memory</p>
    </div>
    ${errorBlock}
    <form method="POST">
      <input type="password" name="password" placeholder="Password" autofocus required />
      <button type="submit">Enter</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './shared/ui/tokens.css';
import './shared/styles/app.css';
import { persistConversationId } from './shared/state';

// A /c/<id> link opens that conversation: boot restores the persisted id, so
// seed it from the URL before the app starts instead of racing the restore.
const linked = /^\/c\/([^/]+)/.exec(window.location.pathname);
if (linked) persistConversationId(decodeURIComponent(linked[1]));

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

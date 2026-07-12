import { ChatProvider } from '../features/chat/ChatContext';
import { AppRouter } from './router';

export function App() {
  return (
    <ChatProvider>
      <AppRouter />
    </ChatProvider>
  );
}

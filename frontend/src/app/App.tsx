import { ChatProvider } from '../features/chat/ChatContext';
import { ThemeProvider } from '../shared/ui/theme';
import { AppRouter } from './router';

export function App() {
  return (
    <ThemeProvider>
      <ChatProvider>
        <AppRouter />
      </ChatProvider>
    </ThemeProvider>
  );
}

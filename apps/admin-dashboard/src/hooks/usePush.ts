import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { onForegroundPush, pushAvailable, registerForPush } from '../lib/pushNotifications';
import { useAuth } from './useAuth';

/** Opt-in web push for alerts (alert-service sends to users/{uid}.fcmTokens). */
export function usePush() {
  const { session, isMockMode, getToken } = useAuth();
  const queryClient = useQueryClient();
  const [available, setAvailable] = React.useState(false);
  const [permission, setPermission] = React.useState<NotificationPermission>(
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );

  React.useEffect(() => {
    if (isMockMode || !session) return;
    let off: () => void = () => undefined;
    void (async () => {
      const ok = await pushAvailable();
      setAvailable(ok);
      if (!ok) return;
      // Already granted earlier: refresh the token silently (tokens rotate).
      if (Notification.permission === 'granted') await registerForPush(getToken).catch(() => undefined);
      off = await onForegroundPush(() => void queryClient.invalidateQueries({ queryKey: ['alerts'] }));
    })();
    return () => off();
  }, [isMockMode, session, getToken, queryClient]);

  const enable = React.useCallback(async () => {
    setPermission(await registerForPush(getToken).catch(() => Notification.permission));
  }, [getToken]);

  return { available, permission, enable };
}

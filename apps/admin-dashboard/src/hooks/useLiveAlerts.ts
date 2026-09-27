import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import type { Alert } from '@vayusetu/shared-types';
import { useToast } from '@vayusetu/ui-components';
import { firebaseDb } from '../lib/firebase';
import { alertListenerFilters } from '../lib/alertListenerQuery';
import { useAuth } from './useAuth';

/**
 * Real-time alert queue. The REST API stays the source of truth (it applies
 * the same jurisdiction rule and returns the contract shape); this listener
 * on the newest 50 alerts is the change signal that refetches it, and it
 * toasts alerts that arrive while the queue is open.
 *
 * Returns whether the listener is live (false in mock mode or on error, where
 * the queue falls back to polling).
 */
export function useLiveAlerts(): boolean {
  const { session, isMockMode } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [live, setLive] = React.useState(false);

  React.useEffect(() => {
    if (isMockMode || !firebaseDb || !session) return;
    let first = true;
    const q = query(
      collection(firebaseDb, 'alerts'),
      ...alertListenerFilters(session.role, session.jurisdiction).map((f) => where(f.field, '==', f.value)),
      orderBy('createdAt', 'desc'),
      limit(50),
    );
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setLive(true);
        if (first) {
          first = false; // initial snapshot = what the REST call already loaded
          return;
        }
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const a = change.doc.data() as Alert;
          push({
            tone: a.severity === 'critical' || a.severity === 'warning' ? 'error' : 'info',
            title: `New ${a.severity} alert`,
            description: a.title,
          });
        }
        void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      },
      () => setLive(false),
    );
    return () => {
      unsubscribe();
      setLive(false);
    };
  }, [isMockMode, session, queryClient, push]);

  return live;
}

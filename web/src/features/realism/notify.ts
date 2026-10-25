// Desktop notifications (Notification API) for moments that happen while the window is hidden.

import { useApp } from '@/store/app';

export type NotifyPermission = NotificationPermission | 'unsupported';

export function notificationPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface NotifyOptions {
  /** Same tag replaces the previous notification (e.g. a fill, then the trade close). */
  tag?: string;
  /** Stay on screen until dismissed (breaches). */
  sticky?: boolean;
  /** Ignore the hidden-window and settings checks (Settings → "Send a test"). */
  force?: boolean;
}

/** Shows a desktop notification when enabled in settings, permitted, and the window is hidden. */
export function notifyDesktop(title: string, body: string, opts: NotifyOptions = {}): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!opts.force) {
    if (!useApp.getState().settings.notifications) return;
    if (!document.hidden) return;
  }
  try {
    const n = new Notification(title, { body, tag: opts.tag, icon: '/icon.svg', requireInteraction: opts.sticky ?? false });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some platforms only allow notifications from a service worker — nothing to do.
  }
}

import { isVideoJob, type AppSettings, type StudioJob } from '../shared/types';

export type NotificationPreference = 'notifyGeneration' | 'notifyDownload' | 'notifyError';
export interface NotificationWindow {
  isDestroyed(): boolean; isFocused(): boolean; isMinimized(): boolean;
  restore(): void; show(): void; focus(): void;
}
export interface DesktopNotice {
  onClick(handler: () => void): void;
  onFailure(handler: (error: unknown) => void): void;
  show(): void;
}
export interface DesktopNotificationPorts {
  settings(): Pick<AppSettings, NotificationPreference | 'desktopNotifications'>;
  window(): NotificationWindow | undefined;
  closing(): boolean;
  supported(): boolean;
  create(options: { title: string; body: string }): DesktopNotice;
  failed(error: unknown): void;
}

/** Optional desktop delivery must never change the outcome of saved work. */
export class DesktopNotifications {
  private previousBackendState = '';
  constructor(private ports: DesktopNotificationPorts) {}
  private failed(error: unknown) { try { this.ports.failed(error); } catch { /* Diagnostics must also remain optional. */ } }
  send(preference: NotificationPreference, title: string, body: string): boolean {
    try {
      if (this.ports.settings().desktopNotifications !== true || this.ports.closing() || !this.ports.settings()[preference] || !this.ports.supported()) return false;
      const target = this.ports.window();
      if (target?.isDestroyed() || target?.isFocused()) return false;
      const notice = this.ports.create({ title, body });
      notice.onFailure(error => this.failed(error));
      notice.onClick(() => {
        try {
          if (this.ports.closing()) return;
          const current = this.ports.window();
          if (!current || current.isDestroyed()) return;
          if (current.isMinimized()) current.restore();
          current.show(); current.focus();
        } catch (error) { this.failed(error); }
      });
      notice.show(); return true;
    } catch (error) { this.failed(error); return false; }
  }
  jobFinished(job: StudioJob): boolean {
    if (job.status === 'completed') {
      if (isVideoJob(job)) return this.send('notifyGeneration', 'Your video is ready', 'Saved to Video history.');
      return this.send('notifyGeneration', 'Your image is ready', job.draft.batchSize > 1 ? `${job.outputIds.length} images saved to your library.` : 'Saved to your library.');
    }
    return job.status === 'failed' ? this.send('notifyError', 'Generation needs attention', job.error || 'Open the queue for details.') : false;
  }
  backendChanged(state: { state: string; message: string }): void {
    const previous = this.previousBackendState; this.previousBackendState = state.state;
    if (state.state === 'error' && previous !== 'error') this.send('notifyError', 'Image engine needs attention', state.message);
  }
}

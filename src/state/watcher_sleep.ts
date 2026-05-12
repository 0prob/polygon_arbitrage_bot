export class WatcherSleeper {
  private _timer: ReturnType<typeof setTimeout> | null;
  private _resolve: (() => void) | null;

  constructor() {
    this._timer = null;
    this._resolve = null;
  }

  wake() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.();
  }

  async sleep(ms: number, isRunning: () => boolean) {
    if (!isRunning() || ms <= 0) return;
    const promise = new Promise<void>((resolve) => {
      this._resolve = () => {
        this._timer = null;
        this._resolve = null;
        resolve();
      };
      this._timer = setTimeout(() => {
        this._timer = null;
        if (this._resolve === resolve) {
          this._resolve = null;
          resolve();
        }
      }, ms);
    });
    return promise;
  }
}

import type { ConnectedAppSummary } from '@/lib/composio/types';

type ConnectedAppAvatarProps = {
  app: Pick<ConnectedAppSummary, 'name' | 'logoUrl'>;
  className?: string;
};

export function ConnectedAppAvatar({
  app,
  className = 'h-5 w-5',
}: ConnectedAppAvatarProps) {
  if (app.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={app.logoUrl} alt="" className={`${className} rounded-md border border-stone-200 bg-white object-cover`} />;
  }

  return (
    <span
      aria-hidden
      className={`${className} inline-flex items-center justify-center rounded-md border border-stone-200 bg-stone-100 text-[10px] font-semibold text-stone-600`}
    >
      {app.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

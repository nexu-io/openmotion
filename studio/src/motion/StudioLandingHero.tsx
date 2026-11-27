import type { ReactNode } from 'react';

export function StudioLandingHero({ title, description, poster, children }: {
  title: string;
  description: string;
  poster?: string;
  children?: ReactNode;
}) {
  return <header className="om-discovery-hero om-studio-landing-hero">
    {poster && <img src={poster} alt="" />}
    <div className="om-discovery-hero-copy">
      <h1>{title}</h1>
      <p>{description}</p>
      {children && <div className="om-hero-actions">{children}</div>}
    </div>
  </header>;
}

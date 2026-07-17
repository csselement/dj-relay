import {
  Headphones,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";

function Role({
  icon,
  number,
  text,
  title,
}: {
  icon: ReactNode;
  number: string;
  text: string;
  title: string;
}) {
  return (
    <article className="marketing-role">
      <span className="marketing-role-number" aria-hidden="true">{number}</span>
      <div className="marketing-role-heading">
        <span className="marketing-role-icon" aria-hidden="true">{icon}</span>
        <h3>{title}</h3>
      </div>
      <p>{text}</p>
    </article>
  );
}

export function HomePage() {
  return (
    <AppShell
      shellClassName="marketing-shell"
      contentClassName="marketing-content"
      headerAction={<a className="header-console-link" href="/admin">Producer console</a>}
      footer={null}
    >
      <section className="marketing-home" aria-labelledby="marketing-home-title">
        <div className="marketing-home-inner">
          <div className="marketing-home-copy">
            <p className="marketing-eyebrow">One link. Three simple roles.</p>
            <h1 id="marketing-home-title">A private room <br aria-hidden="true" />for the mix.</h1>
            <p className="marketing-home-intro">
              The producer creates a session, a DJ shares live stereo audio, and invited listeners join from any modern browser.
            </p>
            <p className="marketing-trust-line">
              <span>Private by invitation</span>
              <span>Live stereo</span>
              <span>Browser based</span>
            </p>
          </div>
          <div className="marketing-roles">
            <Role
              number="01"
              icon={<User size={25} weight="regular" />}
              title="Producer"
              text="Creates the room and sends private, expiring links."
            />
            <Role
              number="02"
              icon={<Headphones size={25} weight="regular" />}
              title="DJ"
              text="Chooses an audio source and starts the live mix."
            />
            <Role
              number="03"
              icon={<UsersThree size={25} weight="regular" />}
              title="Listener"
              text="Opens a link and listens—no account or app required."
            />
          </div>
        </div>
      </section>
    </AppShell>
  );
}

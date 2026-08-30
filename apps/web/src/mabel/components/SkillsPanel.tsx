import type { MabelBootstrap } from "../types";

type SkillsPanelProps = {
  skills: MabelBootstrap["skills"];
};

export function SkillsPanel({ skills }: SkillsPanelProps) {
  return (
    <section className="mabel-panel">
      <div className="mabel-panel-heading">
        <span>Skills</span>
        <small>{skills.length}</small>
      </div>
      {skills.length === 0 ? (
        <p className="mabel-muted">No governed skills yet. Draft, test, and publish skills from Mabel.</p>
      ) : (
        skills.map((skill) => (
          <article key={skill.id} className="mabel-list-item">
            <strong>{skill.name}</strong>
            <span>{skill.status}</span>
          </article>
        ))
      )}
    </section>
  );
}

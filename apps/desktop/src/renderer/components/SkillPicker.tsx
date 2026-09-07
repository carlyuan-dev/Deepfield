import type { SkillSummary } from "@deepfield/contracts";

export interface SkillPickerProps {
  skills: SkillSummary[];
  value: string | undefined;
  disabled: boolean;
  onChange(name: string | undefined): void;
}

export function SkillPicker({ skills, value, disabled, onChange }: SkillPickerProps) {
  return (
    <select
      aria-label="Skill"
      className="skill-picker"
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const selected = event.target.value;
        onChange(selected.length > 0 ? selected : undefined);
      }}
    >
      <option value="">不使用 Skill</option>
      {skills.map((skill) => (
        <option key={skill.name} value={skill.name} title={skill.description}>
          {skill.name}
        </option>
      ))}
    </select>
  );
}

import { Value } from "typebox/value";
import {
  CreateProjectInputSchema,
  type CreateProjectInput,
  type Project,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";

export class ProjectServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectServiceError";
  }
}

export class ProjectService {
  constructor(private readonly repositories: Repositories) {}

  create(input: CreateProjectInput): Project {
    if (!Value.Check(CreateProjectInputSchema, input)) {
      throw new ProjectServiceError("invalid project input");
    }
    if (input.industry.trim().length === 0) {
      throw new ProjectServiceError("industry must not be blank");
    }
    return this.repositories.projects.create({
      ...input,
      industry: input.industry.trim(),
    });
  }

  list(): Project[] {
    return this.repositories.projects.list();
  }
}

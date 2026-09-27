// Input for the OpenAPI drift test: every shared type, plus the concrete
// Paginated<T> instantiations the list endpoints return.
import type { Alert, Paginated, ResourceRequest, Submission } from '../src/index';

export * from '../src/index';

export type PaginatedSubmission = Paginated<Submission>;
export type PaginatedAlert = Paginated<Alert>;
export type PaginatedResourceRequest = Paginated<ResourceRequest>;

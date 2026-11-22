import { ButtonLink, Container } from '../components/ui';

export function NotFound() {
  return (
    <div className="py-24">
      <Container className="flex flex-col items-start gap-5">
        <h1 className="text-4xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="text-muted">There is nothing at this address.</p>
        <ButtonLink href="/" tone="primary">
          Back to the start
        </ButtonLink>
      </Container>
    </div>
  );
}

import { SignInWithTempoDemo } from "../components/SignInWithTempoDemo";
import { TempoProviders } from "../components/TempoProviders";

export default function Page() {
  return (
    <TempoProviders>
      <SignInWithTempoDemo />
    </TempoProviders>
  );
}

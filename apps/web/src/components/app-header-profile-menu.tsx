import { Link, useNavigate } from "@tanstack/react-router";
import { BookOpen, LogOut, UserRound } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { authClient } from "~/lib/auth-client";
import { isLocalDevEnvironment } from "~/lib/dev-mode-access";
import { useDevStore } from "~/stores/dev";

export type AppHeaderProfileMenuUser = {
  id: string;
  name: string;
  email?: string | null;
};

type AppHeaderProfileMenuProps = {
  user: AppHeaderProfileMenuUser;
  isAdmin: boolean;
  isAnonymous?: boolean;
  /** Called after `signOut` succeeds, before navigation. */
  onAfterSignOut?: () => void;
  /** Where to send the user after sign-out. */
  signOutNavigateTo?: "/" | "/practice";
};

export function AppHeaderProfileMenu({
  user,
  isAdmin,
  isAnonymous = false,
  onAfterSignOut,
  signOutNavigateTo = "/",
}: AppHeaderProfileMenuProps) {
  const navigate = useNavigate();
  const devMode = useDevStore((s) => s.devMode);
  const showDevUserId = devMode && (isAdmin || isLocalDevEnvironment());

  async function handleSignOut() {
    await authClient.signOut();
    onAfterSignOut?.();
    navigate({ to: signOutNavigateTo, replace: true });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="text-muted-foreground" aria-label="Account menu">
          <UserRound className="size-[1.25rem]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{user.name}</span>
            {isAnonymous ? (
              <span className="text-xs text-muted-foreground">
                Guest — save with an account to keep progress across devices.
              </span>
            ) : (
              user.email && <span className="text-xs text-muted-foreground font-normal truncate">{user.email}</span>
            )}
            {showDevUserId && (
              <span className="text-[10px] font-mono text-muted-foreground/90 pt-1 break-all">id: {user.id}</span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/vocab">
            <BookOpen className="size-4 opacity-70" />
            My Vocab
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">Settings</Link>
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem asChild>
            <Link to="/admin">Admin</Link>
          </DropdownMenuItem>
        )}
        {isAnonymous ? (
          <>
            <DropdownMenuItem asChild>
              <Link to="/auth/register">Create account</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/auth/login">Sign in</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void handleSignOut()}>
              <LogOut className="size-4 opacity-70" />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

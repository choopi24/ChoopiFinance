import { TrendingUp, Plus } from "lucide-react";
import { Button } from "./Button";

interface WelcomeStateProps {
  userName?: string;
  onAdd?: () => void;
}

export function WelcomeState({ userName, onAdd }: WelcomeStateProps) {
  return (
    <div className="cf-welcome">
      <div className="cf-welcome-icon">
        <TrendingUp size={32} strokeWidth={1.4} />
      </div>
      <h2 className="cf-welcome-title">
        Welcome{userName ? `, ${userName}` : ""}
      </h2>
      <p className="cf-welcome-body">
        Start tracking your portfolio by adding your first investment.
        Choopi supports stocks, ETFs, crypto, pensions, and more.
      </p>
      <Button variant="primary" onClick={onAdd}>
        <Plus size={15} strokeWidth={2} />
        Add your first investment
      </Button>
    </div>
  );
}

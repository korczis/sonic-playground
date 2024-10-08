defmodule SonicPlayground.Repo do
  use Ecto.Repo,
    otp_app: :sonic_playground,
    adapter: Ecto.Adapters.SQLite3
end

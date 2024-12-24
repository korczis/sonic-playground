defmodule BlogKorczisCom.Repo do
  use Ecto.Repo,
    otp_app: :blog_korczis_com,
    adapter: Ecto.Adapters.SQLite3
end

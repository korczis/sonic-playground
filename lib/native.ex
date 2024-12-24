defmodule BlogKorczisCom.Native do
  use Rustler, otp_app: :blog_korczis_com, crate: "blog_korczis_com"

  # When your NIF is loaded, it will override this function.
  def add(_a, _b), do: :erlang.nif_error(:nif_not_loaded)
end

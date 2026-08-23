use crate::module::ModuleBackend;
pub struct JwtModule;
impl ModuleBackend for JwtModule {
    fn id(&self) -> &'static str {
        "jwt"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
